/**
 * Human-readable text for co-op commands (rejection toasts) and the pending-value key a command touched, so a refused
 * command's optimistic UI value can be dropped at once.
 */
import { BUILDINGS } from '../../core/defs';
import type { Command } from '../../net/types';
import { pendingKey } from '../pending';

/** "Couldn't build a Wooden House" — the lead of a rejection toast (the host's reason follows). */
export function describeRejected(cmd: Command): string {
  switch (cmd.op) {
    case 'place': return `Couldn't build the ${BUILDINGS[cmd.type]?.name ?? 'building'}`;
    case 'road': return cmd.kind === 'stone' ? "Couldn't lay the stone road" : "Couldn't lay the road";
    case 'removeRoad': return "Couldn't remove the road";
    case 'mark': return "Couldn't mark the area for clearing";
    case 'unmark': return "Couldn't cancel the clearing orders";
    case 'demolish': return "Couldn't demolish the building";
    case 'workers': return "Couldn't change the workers";
    case 'builders': return "Couldn't change the builders";
    case 'crop': return "Couldn't change what is grown there";
    case 'recipe': return "Couldn't change the recipe";
    case 'pause': return cmd.paused ? "Couldn't pause the building" : "Couldn't resume the building";
    case 'priority': return "Couldn't change the priority";
    case 'trade': return 'The merchant refused the trade';
    case 'requestMerchant': return "Couldn't request a merchant";
    case 'nomads': return cmd.accept ? "Couldn't welcome the nomads" : "Couldn't turn the nomads away";
    case 'speed': return "Couldn't change the game speed";
  }
}

/** Rejection toast text: lead + reason (reasons from the sim are full sentences or short phrases). */
export function rejectionText(cmd: Command, reason: string): string {
  const r = (reason || '').trim();
  return r ? `${describeRejected(cmd)}: ${r.charAt(0).toLowerCase()}${r.slice(1)}` : `${describeRejected(cmd)}.`;
}

/** The pending-value key a command sets in the UI (see pending.ts), or null. */
export function pendingKeyFor(cmd: Command): string | null {
  switch (cmd.op) {
    case 'workers': return pendingKey.workers(cmd.id);
    case 'builders': return pendingKey.builders();
    case 'pause': return pendingKey.paused(cmd.id);
    case 'priority': return pendingKey.priority(cmd.id);
    case 'crop': return pendingKey.crop(cmd.id);
    case 'recipe': return pendingKey.recipe(cmd.id);
    case 'requestMerchant': return pendingKey.merchant();
    default: return null;
  }
}
