import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOMAIN_DIR = join(__dirname, '..', '..', 'docs', 'domain');
const documentCache = new Map();

function loadDomainDocument(repoName) {
    if (documentCache.has(repoName)) return documentCache.get(repoName);
    try {
        const content = readFileSync(join(DOMAIN_DIR, `${repoName}.md`), 'utf8');
        documentCache.set(repoName, content);
        return content;
    } catch {
        documentCache.set(repoName, '');
        return '';
    }
}

function tokenize(value) {
    return new Set(String(value || '')
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(token => token.length >= 3));
}

export function splitDomainSections(markdown) {
    const sections = [];
    let current = { heading: 'Overview', content: '' };
    for (const line of String(markdown || '').split(/\r?\n/)) {
        const heading = line.match(/^#{1,4}\s+(.+)$/);
        if (heading) {
            if (current.content.trim()) sections.push(current);
            current = { heading: heading[1].trim(), content: `${line}\n` };
        } else {
            current.content += `${line}\n`;
        }
    }
    if (current.content.trim()) sections.push(current);
    return sections;
}

export function selectDomainKnowledge(repoName, { changedFiles = [], commitMessage = '', maxChars = 6000 } = {}) {
    const markdown = loadDomainDocument(repoName);
    if (!markdown) return '';

    const queryTokens = tokenize(`${changedFiles.join(' ')} ${commitMessage}`);
    const ranked = splitDomainSections(markdown).map((section, index) => {
        const sectionTokens = tokenize(`${section.heading} ${section.content}`);
        let overlap = 0;
        for (const token of queryTokens) if (sectionTokens.has(token)) overlap += 1;
        const overviewBonus = index === 0 || /overview|glossary|architecture/i.test(section.heading) ? 0.5 : 0;
        return { ...section, index, score: overlap + overviewBonus };
    }).sort((a, b) => b.score - a.score || a.index - b.index);

    const selected = [];
    let used = 0;
    for (const section of ranked) {
        if (selected.length >= 5) break;
        const text = section.content.trim();
        if (selected.length > 0 && section.score <= 0) continue;
        if (used + text.length > maxChars) {
            if (selected.length === 0) {
                selected.push(text.slice(0, maxChars));
                used = maxChars;
                break;
            }
            continue;
        }
        selected.push(text);
        used += text.length + 2;
    }
    return selected.join('\n\n');
}

export { loadDomainDocument };
