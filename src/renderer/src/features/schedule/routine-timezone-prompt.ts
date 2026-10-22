import type {
  EventRoutineOwner,
  RoutineCalendar,
  RoutineCalendarInput,
  RoutineCalendarOwner,
  RoutineCalendarRoutine,
  ServerSummary,
} from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { currentText } from "@openbot/ui/text";
import { createEffect, onCleanup, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import { desktopEventRoutinesApi, type EventRoutinesApi } from "../conversation/routine-webhooks-api";
import type { HostTimezoneCalls } from "../servers/ServerTimezoneSetting";
import { serverCanAdminister } from "../servers/server-capabilities";

/**
 * One server whose routines the user can move: an owner or admin of a host with `events-v1`, or this
 * computer. `timezone` is set when the host also has `host-timezone-v1`.
 */
export interface RoutineZoneTarget {
  id: string;
  name: string;
  calendar: (input: RoutineCalendarInput) => Promise<RoutineCalendar>;
  events: Pick<EventRoutinesApi, "listRoutines" | "saveRoutine">;
  timezone?: HostTimezoneCalls | undefined;
}

/** This computer and each joined server that is online and lets this account move its routines. */
export function desktopRoutineZoneTargets(servers: readonly ServerSummary[]): RoutineZoneTarget[] {
  return servers
    .filter((server) => server.state === "online" && serverCanAdminister(server, "events-v1"))
    .map((server) => ({
      id: server.id,
      name: server.name,
      calendar: (input) => window.openbot.agent.routineCalendar(input, server.id),
      events: desktopEventRoutinesApi(server.id),
      timezone: serverCanAdminister(server, "host-timezone-v1") ? window.openbot.hostAdmin : undefined,
    }));
}

const toastId = (serverId: string) => `routine-timezone-move:${serverId}`;
const storageKey = (serverId: string) => `openbot:routine-timezone-answers:${serverId}`;

function deviceZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The routine zones that the user answered on `serverId` for the device zone `zone`. The stored value
 * is one zone name for each line: the device zone first, then the answered zones.
 */
function answeredZones(serverId: string, zone: string): string[] {
  try {
    const [stored, ...answered] = (window.localStorage.getItem(storageKey(serverId)) ?? "").split("\n");
    return stored === zone ? answered : [];
  } catch {
    return [];
  }
}

function writeAnswer(serverId: string, zone: string, from: string): void {
  try {
    window.localStorage.setItem(storageKey(serverId), [zone, ...answeredZones(serverId, zone), from].join("\n"));
  } catch {
    // Blocked storage asks again on the next check.
  }
}

/** An interval routine counts from its anchor instant, so its zone does not move its runs. */
function followsClock(routine: RoutineCalendarRoutine): boolean {
  return routine.schedule.kind !== "interval";
}

function eventOwner(owner: RoutineCalendarOwner): EventRoutineOwner {
  return owner.kind === "agent" ? { kind: "agent", id: owner.agentId } : { kind: "channel", id: owner.channelId };
}

const zoneLabel = (zone: string) => zone.replaceAll("_", " ");

/**
 * Saves each routine in `from` again in `to`. The host keeps its ID and runs and computes the next run
 * at the same clock time in `to`. A Server Settings zone of `from` follows, so new routines match.
 */
async function moveRoutines(target: RoutineZoneTarget, routines: RoutineCalendarRoutine[], from: string, to: string) {
  const owners = new Map<string, EventRoutineOwner>();
  for (const routine of routines) {
    const owner = eventOwner(routine.owner);
    owners.set(`${owner.kind}:${owner.id}`, owner);
  }
  const ids = new Set(routines.map((routine) => routine.id));
  let moved = 0;
  let failed = 0;
  for (const owner of owners.values()) {
    const records = await target.events.listRoutines({ owner });
    for (const record of records) {
      if (!ids.has(record.id) || record.timezone !== from || record.trigger.kind !== "schedule") continue;
      try {
        const saved = await target.events.saveRoutine({
          id: record.id,
          owner: record.owner,
          name: record.name,
          instruction: record.instruction,
          active: record.active,
          timezone: to,
          trigger: record.trigger,
          ...(record.limitPolicy ? { limitPolicy: record.limitPolicy } : {}),
          ...(record.missedPolicy ? { missedPolicy: record.missedPolicy } : {}),
        });
        if (saved.routine.timezone === to) moved += 1;
        else failed += 1;
      } catch {
        // For example a one-time run whose time is already past in the new zone.
        failed += 1;
      }
    }
  }
  if (target.timezone) {
    const setting = await target.timezone.getTimezone(target.id);
    if (setting.timezone === from) await target.timezone.setTimezone(to, target.id);
  }
  return { moved, failed };
}

/**
 * Asks to move the routines of each server in `targets` to the device's zone after the zone changed.
 * It asks once for each zone that routines use on a server, and again only after the next change of
 * the device zone.
 */
export function createRoutineTimezonePrompt(targets: () => RoutineZoneTarget[]): void {
  const checking = new Set<string>();
  /** The source and device zone of the toast that shows for each server. */
  const shown = new Map<string, string>();

  async function check(target: RoutineZoneTarget): Promise<void> {
    if (checking.has(target.id)) return;
    checking.add(target.id);
    try {
      const zone = deviceZone();
      const answered = answeredZones(target.id, zone);
      const from = new Date(Date.now() + 60_000);
      const calendar = await target.calendar({
        from: from.toISOString(),
        to: new Date(from.getTime() + 60_000).toISOString(),
      });
      const byZone = new Map<string, RoutineCalendarRoutine[]>();
      for (const routine of calendar.routines) {
        if (routine.timezone === zone || answered.includes(routine.timezone) || !followsClock(routine)) continue;
        byZone.set(routine.timezone, [...(byZone.get(routine.timezone) ?? []), routine]);
      }
      const next = [...byZone.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      const key = next ? `${next[0]}>${zone}` : undefined;
      if (key === shown.get(target.id)) return;
      if (!next) {
        shown.delete(target.id);
        toast.dismiss(toastId(target.id));
        return;
      }
      shown.set(target.id, `${next[0]}>${zone}`);
      const [source, routines] = next;
      const { t } = currentText();
      const answer = (move: boolean) => {
        writeAnswer(target.id, zone, source);
        shown.delete(target.id);
        if (move) void runMove(target, routines, source, zone);
        else void check(target);
      };
      toast(t("routine.timezoneMove.title", { zone: zoneLabel(zone) }), {
        id: toastId(target.id),
        description: t("routine.timezoneMove.description", {
          count: routines.length,
          server: target.name,
          from: zoneLabel(source),
          zone: zoneLabel(zone),
        }),
        // A toast closed without an answer comes back after the next start.
        duration: Number.POSITIVE_INFINITY,
        action: { label: t("routine.timezoneMove.move"), onClick: () => answer(true) },
        cancel: { label: t("routine.timezoneMove.keep"), onClick: () => answer(false) },
      });
    } catch {
      // The host is not ready or does not answer. The next check tries again.
    } finally {
      checking.delete(target.id);
    }
  }

  async function runMove(
    target: RoutineZoneTarget,
    routines: RoutineCalendarRoutine[],
    from: string,
    to: string,
  ): Promise<void> {
    const text = currentText();
    try {
      const { moved, failed } = await moveRoutines(target, routines, from, to);
      if (failed > 0) {
        actionToast.warning(
          text.t("routine.timezoneMove.partial", { count: failed, server: target.name, zone: zoneLabel(to) }),
        );
      } else {
        actionToast.success(
          text.t("routine.timezoneMove.moved", { count: moved, server: target.name, zone: zoneLabel(to) }),
        );
      }
    } catch (error) {
      actionToast.error(text.errorMessage(error, text.t("routine.timezoneMove.failed")));
    }
    await check(target);
  }

  function checkAll(): void {
    const current = untrack(targets);
    for (const serverId of shown.keys()) {
      if (current.some((target) => target.id === serverId)) continue;
      shown.delete(serverId);
      toast.dismiss(toastId(serverId));
    }
    for (const target of current) void check(target);
  }

  createEffect(
    () =>
      targets()
        .map((target) => target.id)
        .join("\n"),
    () => checkAll(),
  );
  const recheck = () => {
    if (document.visibilityState === "visible") checkAll();
  };
  window.addEventListener("focus", recheck);
  document.addEventListener("visibilitychange", recheck);
  onCleanup(() => {
    window.removeEventListener("focus", recheck);
    document.removeEventListener("visibilitychange", recheck);
    for (const serverId of shown.keys()) toast.dismiss(toastId(serverId));
  });
}
