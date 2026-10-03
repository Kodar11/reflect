import type { LearnedRuleService } from './LearnedRuleService.js';

/**
 * Renderer bridge for learned patterns. Follows the existing registrar
 * pattern: thin frame-validated handlers returning plain JSON.
 *
 * The renderer never decides eligibility. It asks for the current suggestion,
 * renders it, and reports the user's answer — remember / not now / never.
 * No database primitive and no Gemini detail crosses this boundary.
 */
export function registerLearnedRulesIpc(
  service: LearnedRuleService,
  ipcMainHandle: (key: string, handler: (payload?: any) => any) => void,
) {
  const requireId = (p: { candidateId?: string } | undefined, channel: string): string => {
    if (!p || typeof p.candidateId !== 'string' || !p.candidateId) {
      throw new Error(`${channel} requires candidateId`);
    }
    return p.candidateId;
  };

  /** All candidates with derived state — the Rules page and diagnostics. */
  ipcMainHandle('learnedRules:listCandidates', () => service.listCandidates());
  ipcMainHandle('learnedRules:getCandidate', (p?: { candidateId?: string }) =>
    service.getCandidate(requireId(p, 'learnedRules:getCandidate')),
  );

  /** Every eligible candidate (Rules page; nothing is marked as shown). */
  ipcMainHandle('learnedRules:listSuggestions', () => service.listSuggestions());
  /** The one suggestion to surface now, if any (marks it as shown). */
  ipcMainHandle('learnedRules:nextSuggestion', () => service.nextSuggestion());

  ipcMainHandle('learnedRules:confirmCandidate', (p?: { candidateId?: string }) => {
    const result = service.confirmCandidate(requireId(p, 'learnedRules:confirmCandidate'));
    return { ok: true, ...result };
  });
  ipcMainHandle('learnedRules:snoozeCandidate', (p?: { candidateId?: string }) => {
    service.snoozeCandidate(requireId(p, 'learnedRules:snoozeCandidate'));
    return { ok: true };
  });
  ipcMainHandle('learnedRules:dismissCandidate', (p?: { candidateId?: string }) => {
    service.dismissCandidate(requireId(p, 'learnedRules:dismissCandidate'));
    return { ok: true };
  });
  ipcMainHandle('learnedRules:reactivateCandidate', (p?: { candidateId?: string }) => {
    service.reactivateCandidate(requireId(p, 'learnedRules:reactivateCandidate'));
    return { ok: true };
  });
}
