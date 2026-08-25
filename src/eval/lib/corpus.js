import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadDailyCorpus(dailyDir) {
    const files = (await readdir(dailyDir)).filter(name => name.endsWith('.json')).sort();
    const hash = createHash('sha256');
    const commits = [];

    for (const file of files) {
        const raw = await readFile(join(dailyDir, file));
        hash.update(file);
        hash.update('\0');
        hash.update(raw);
        const report = JSON.parse(raw.toString('utf8'));
        for (const [repo, value] of Object.entries(report.repositories || {})) {
            for (const commit of value.commits || []) {
                commits.push({
                    ...commit,
                    repo,
                    day: String(commit.date || report.date).slice(0, 10),
                    id: commit.shortId || String(commit.commitId).slice(0, 8),
                    riskLevel: commit.summary?.riskLevel || null,
                    changeType: commit.summary?.changeType || null,
                });
            }
        }
    }

    commits.sort((a, b) => `${a.repo}:${a.commitId}`.localeCompare(`${b.repo}:${b.commitId}`));
    return {
        commits,
        files,
        corpusHash: hash.digest('hex'),
        dateRange: { from: files[0]?.slice(0, 10) || null, to: files.at(-1)?.slice(0, 10) || null },
    };
}

export function groupBy(items, keyFn) {
    const groups = new Map();
    for (const item of items) {
        const key = keyFn(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    return groups;
}

export function mulberry32(seed) {
    return function random() {
        let value = seed += 0x6D2B79F5;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

export function sampleStable(items, count, random) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, count);
}

