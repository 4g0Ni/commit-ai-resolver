const URL_PATTERN = /https?:\/\/\S+/giu;
const TEMPLATE_LINE = /^(?:react version(?:\s*:.*)?|steps? to reproduce|repro steps|link to (?:code )?example(?:\s*:.*)?|the current behavior|current behavior|the expected behavior|expected behavior|what is the current behavior|what is the expected behavior)\s*:?[\s#-]*$/iu;
const SECTION_LINE = /^(?:the )?(current behavior|expected behavior|actual behavior|repro(?:duction)?(?: steps?)?|steps? to reproduce)\s*:?[\s#-]*$/iu;
const TECHNICAL_SIGNAL = /(?:\b(?:error|exception|warning|crash|regression|incorrect|fails?|broken|hydrate|render|compiler|eslint|devtools)\b|[`'"].+[`'"]|[a-z][A-Z][\p{L}\p{N}_]*|[\w.-]+\/[\w./-]+)/iu;
const LOW_VALUE_TERMS = new Set([
    'a', 'an', 'and', 'about', 'after', 'again', 'behavior', 'before', 'below', 'browser', 'bug', 'code',
    'current', 'does', 'expected', 'following', 'from', 'have', 'issue', 'link', 'react',
    'reproduce', 'repro', 'same', 'steps', 'that', 'the', 'this', 'to', 'of', 'in', 'is', 'it', 'on', 'for',
    'version', 'what', 'when', 'which', 'with', 'would', 'should', 'could', 'using', 'works', 'work', 'example',
]);

function cleanQuery(value) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(URL_PATTERN, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function truncateAtBoundary(value, maximum) {
    if (value.length <= maximum) return value;
    const prefix = value.slice(0, maximum + 1);
    const boundary = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('. '), prefix.lastIndexOf(' '));
    return prefix.slice(0, boundary > maximum * 0.7 ? boundary : maximum).trim();
}

/** Extract the first non-template line, which is the issue/work-item title in RCA cases. */
export function retrievalTitle(query) {
    return cleanQuery(query).split('\n').map(line => line.trim()).find(line => line && !TEMPLATE_LINE.test(line)) || '';
}

/**
 * Build a compact, gold-independent semantic query. It retains the title, behavior
 * sections, errors, and code identifiers while dropping URLs and issue-template noise.
 */
export function buildCompactRetrievalQuery(query, { maximum = 600 } = {}) {
    const cleaned = cleanQuery(query);
    if (!cleaned) return '';
    const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
    const title = retrievalTitle(cleaned);
    const selected = [];
    let activeSection = '';

    const add = line => {
        const normalized = line.replace(/^[-*]\s+/, '').trim();
        if (!normalized || TEMPLATE_LINE.test(normalized) || selected.includes(normalized)) return;
        selected.push(normalized);
    };
    add(title);

    for (const line of lines) {
        if (line === title) continue;
        const section = line.match(SECTION_LINE)?.[1]?.toLowerCase();
        if (section) {
            activeSection = section;
            continue;
        }
        const behaviorSection = activeSection.includes('current')
            || activeSection.includes('actual')
            || activeSection.includes('expected');
        if (behaviorSection || TECHNICAL_SIGNAL.test(line)) add(line);
        if (behaviorSection && selected.join('\n').length >= maximum * 0.75) activeSection = '';
    }

    if (selected.join('\n').length < maximum * 0.55) {
        for (const line of lines) {
            if (line !== title && !TEMPLATE_LINE.test(line)) add(line);
            if (selected.join('\n').length >= maximum) break;
        }
    }
    return truncateAtBoundary(selected.join('\n'), maximum);
}

function tokenPriority(raw, titleTerms, quotedTerms) {
    const lower = raw.toLowerCase();
    let priority = 0;
    if (quotedTerms.has(lower)) priority += 12;
    if (/[a-z][A-Z]/.test(raw) || /[_./:#-]/.test(raw) || /\d/.test(raw)) priority += 9;
    if (titleTerms.has(lower)) priority += 5;
    if (raw.length >= 8) priority += 3;
    if (/^(?:error|exception|warning|crash|regression|hydrate|compiler|eslint|devtools)$/iu.test(raw)) priority += 4;
    if (LOW_VALUE_TERMS.has(lower)) priority -= 12;
    return priority;
}

/** Select distinctive FTS terms from the entire query instead of its first template words. */
export function selectLexicalTerms(query, maximum = 24) {
    const cleaned = cleanQuery(query);
    const title = retrievalTitle(cleaned);
    const titleTerms = new Set((title.match(/[\p{L}\p{N}_./:#-]{2,}/gu) || []).map(term => term.toLowerCase()));
    const quotedTerms = new Set();
    for (const match of cleaned.matchAll(/[`'"]([^`'"]{2,})[`'"]/gu)) {
        for (const term of match[1].match(/[\p{L}\p{N}_./:#-]{2,}/gu) || []) quotedTerms.add(term.toLowerCase());
    }

    const candidates = [];
    let order = 0;
    for (const raw of cleaned.match(/[\p{L}\p{N}_./:#-]{2,}/gu) || []) {
        const variants = [raw, ...raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s./:_#-]+/)];
        for (const value of variants) {
            const term = value.replace(/^[.,:;#/-]+|[.,:;#/-]+$/g, '');
            if (term.length < 2) continue;
            candidates.push({ term, lower: term.toLowerCase(), priority: tokenPriority(term, titleTerms, quotedTerms), order: order++ });
        }
    }

    const bestByTerm = new Map();
    for (const candidate of candidates) {
        const existing = bestByTerm.get(candidate.lower);
        if (!existing || candidate.priority > existing.priority) bestByTerm.set(candidate.lower, candidate);
    }
    return [...bestByTerm.values()]
        .filter(candidate => candidate.priority > -10)
        .sort((left, right) => right.priority - left.priority || left.order - right.order)
        .slice(0, maximum)
        .map(candidate => candidate.term);
}

/** Return deterministic query views for offline multi-query retrieval. */
export function buildRetrievalQueryViews(query, mode = 'raw') {
    const raw = String(query || '').trim();
    const compact = buildCompactRetrievalQuery(raw);
    const title = retrievalTitle(raw);
    if (mode === 'compact') return { dense: [{ channel: 'dense-compact', query: compact || raw, weight: 1 }], lexical: compact || raw };
    if (mode === 'multi') {
        const dense = [{ channel: 'dense-primary', query: raw, weight: 1 }];
        if (compact && compact !== raw) dense.push({ channel: 'dense-compact', query: compact, weight: 0.8 });
        if (title && title !== compact && title !== raw) dense.push({ channel: 'dense-title', query: title, weight: 0.7 });
        return { dense, lexical: compact || raw };
    }
    return { dense: [{ channel: 'dense-primary', query: raw, weight: 1 }], lexical: raw };
}
