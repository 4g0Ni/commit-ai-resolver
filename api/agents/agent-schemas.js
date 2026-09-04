import { z } from 'zod';

export const RETRIEVAL_AGENT_OUTPUT = z.object({
    evidenceSummary: z.string(),
    candidateKeys: z.array(z.string()).max(12),
    confidence: z.number().min(0).max(1),
    evidenceVerdict: z.enum(['SEARCH', 'ASK_USER', 'ABSTAIN']),
    needsClarification: z.boolean(),
    clarificationQuestion: z.string().nullable(),
    recommendedNextStep: z.enum(['answer', 'investigate', 'refine_search', 'clarify', 'abstain']),
    queriesUsed: z.array(z.string()).max(6),
});

export const DIFF_INVESTIGATOR_OUTPUT = z.object({
    analysis: z.string(),
    rootCauseCandidateKey: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    mechanism: z.string().nullable(),
    hypotheses: z.array(z.object({
        candidateKey: z.string(),
        claim: z.string(),
        supportingEvidence: z.array(z.string()).max(6),
        contradictingEvidence: z.array(z.string()).max(6),
        confidence: z.number().min(0).max(1),
    })).max(8),
    needsMoreEvidence: z.boolean(),
    recommendedQueries: z.array(z.string()).max(5),
});

export const EVIDENCE_CRITIC_OUTPUT = z.object({
    verdict: z.enum(['PASS', 'RETRY', 'PARTIAL']),
    qualityScore: z.number().min(0).max(1),
    supportedCandidateKeys: z.array(z.string()).max(12),
    unsupportedClaims: z.array(z.string()).max(8),
    missingEvidence: z.array(z.string()).max(8),
    recommendedAction: z.enum(['answer', 'search_again', 'inspect_more_diffs', 'ask_user', 'abstain']),
    feedback: z.string(),
});

export const SUPERVISOR_OUTPUT = z.object({
    type: z.enum(['answer', 'clarification']),
    reply: z.string(),
    confidence: z.number().min(0).max(1),
    citedCandidateKeys: z.array(z.string()).max(12),
    suggestedActions: z.array(z.string()).max(5),
    decisionSummary: z.string(),
});

