# check-suite-gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actions 上で動く check_suite.completed 起点の集約 gate Action を v1 として実装し、 dist commit + script/release 経由で配布できる状態にする。

**Architecture:** TypeScript で書いた JavaScript Action。 `check_suite.completed` で起動し、 `listSuitesForRef` + `listForSuite` で同 SHA の全 check_run を集めて filter→ 集約評価→ commit status を書く。 `github.run_attempt > 1` で起動した場合は救出モードで未完了 check_run を除外する。 stuck 解消は集約 status の `target_url` 経由で maintainer が "Re-run all jobs" を押す動線で行う。

**Tech Stack:** TypeScript / Node.js 24 / esbuild / vitest / @octokit/rest / @actions/core / @actions/github / `path.matchesGlob` (Node.js 標準) / actions/typescript-action template

**Spec:** `docs/superpowers/specs/2026-05-05-check-suite-gate-design.md`

---

## File Structure

```
.
├── .github/
│   └── workflows/
│       ├── ci.yml             # lint / typecheck / unit test / dist 整合性チェック
│       └── test-self.yml      # self-hosting integration test (この repo 自身に gate を適用)
├── action.yml                 # Action metadata (input / output / runs.using: node24)
├── package.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── script/
│   └── release                # actions/typescript-action template の release script
├── src/
│   ├── index.ts               # action entry point (input parse → aggregator → status write)
│   ├── inputs.ts              # action input の parse / validation
│   ├── conclusion.ts          # check_run の conclusion を緑 / 赤 / pending に分類
│   ├── filter.ts              # ignore-apps / ignore-checks フィルタ
│   ├── self-exclusion.ts      # gate 自身の check_run を除外 (details_url から run_id 抽出)
│   ├── api.ts                 # octokit wrapper (retry / pagination)
│   ├── aggregator.ts          # 集約ロジック (通常 / 救出モード分岐)
│   └── status.ts              # commit status writer (target_url 組み立て + 5xx retry)
├── __tests__/
│   ├── conclusion.test.ts
│   ├── filter.test.ts
│   ├── self-exclusion.test.ts
│   ├── api.test.ts
│   ├── aggregator.test.ts
│   └── status.test.ts
├── dist/
│   └── index.js               # esbuild bundle (commit)
└── README.md
```

---

## Task 1: actions/typescript-action template から雛形を取り込む

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `script/release`, `.gitignore`, `.node-version`
- Modify: 既存のないリポにファイルを追加するだけ

- [ ] **Step 1: actions/typescript-action を一時 clone**

```bash
git clone --depth 1 https://github.com/actions/typescript-action.git /tmp/ts-action-template
```

- [ ] **Step 2: 雛形ファイルを project にコピー**

`docs/`、 `__tests__/`、 `src/`、 `dist/`、 `action.yml`、 `README.md` 等は本 plan で別途 task として作る/上書きするので、 ここではビルド・テスト基盤に関わるファイルのみコピー。

プロジェクトルート (この repo の作業ディレクトリ) で:

```bash
cp /tmp/ts-action-template/package.json .
cp /tmp/ts-action-template/tsconfig.json .
cp /tmp/ts-action-template/eslint.config.mjs ./eslint.config.js 2>/dev/null || cp /tmp/ts-action-template/eslint.config.js .
cp /tmp/ts-action-template/vitest.config.ts . 2>/dev/null || cp /tmp/ts-action-template/jest.config.js .
cp -r /tmp/ts-action-template/script .
cp /tmp/ts-action-template/.gitignore .
cp /tmp/ts-action-template/.node-version .
cp /tmp/ts-action-template/.prettierrc.json .
```

- [ ] **Step 3: package.json を check-suite-gate 向けに上書き**

```json
{
  "name": "check-suite-gate",
  "version": "0.0.0",
  "private": true,
  "description": "Aggregate check_suite results into a single commit status (multi-workflow alls-green successor)",
  "main": "dist/index.js",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --target=node24 --outfile=dist/index.js",
    "lint": "eslint src/ __tests__/",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "all": "npm run lint && npm run typecheck && npm run test && npm run build"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/pkgdeps/check-suite-gate.git"
  },
  "keywords": ["github", "actions", "check-suite", "merge-gate", "monorepo"],
  "author": "azu",
  "license": "MIT",
  "dependencies": {
    "@actions/core": "^1.11.1",
    "@actions/github": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@typescript-eslint/eslint-plugin": "^8.20.0",
    "@typescript-eslint/parser": "^8.20.0",
    "esbuild": "^0.24.0",
    "eslint": "^9.18.0",
    "prettier": "^3.4.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 4: tsconfig.json を確認・調整 (strict / target ES2023 / module Node16)**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "Node16",
    "moduleResolution": "Node16",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "./lib",
    "rootDir": "./src",
    "declaration": false,
    "sourceMap": true,
    "lib": ["ES2023"]
  },
  "include": ["src/**/*", "__tests__/**/*"],
  "exclude": ["node_modules", "dist", "lib"]
}
```

- [ ] **Step 5: vitest.config.ts (新規 or 上書き)**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
});
```

- [ ] **Step 6: .node-version を 24 に**

```bash
echo "24" > .node-version
```

- [ ] **Step 7: 依存をインストール**

```bash
ni
```

(プロジェクトルールにより `ni` を使用。 npm install 相当)

- [ ] **Step 8: lint / typecheck / test が通ること確認 (まだコードがないので空 / no-op で OK)**

```bash
nr typecheck
```
Expected: PASS (src/ は空でも tsc は素通り)

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json eslint.config.js vitest.config.ts script .gitignore .node-version .prettierrc.json package-lock.json
git commit -m "chore: scaffold from actions/typescript-action template (node24)"
```

---

## Task 2: action.yml を作成

**Files:**
- Create: `action.yml`

- [ ] **Step 1: action.yml を作成**

```yaml
name: check-suite-gate
description: |
  Aggregate check_suite results on the same commit into a single commit status.
  Multi-workflow alls-green successor for monorepo + Renovate environments.
author: azu

branding:
  icon: check-circle
  color: green

inputs:
  context:
    description: 'Commit status context name to write'
    required: false
    default: 'check-suite-gate/all-passed'
  ignore-apps:
    description: 'Comma-separated GitHub App slugs whose check_runs are ignored (e.g. dependabot[bot])'
    required: false
    default: ''
  ignore-checks:
    description: 'Comma-separated check_run name patterns to ignore. Glob (* / ?) supported (e.g. optional-*,docs-only)'
    required: false
    default: ''
  token:
    description: 'GitHub token used to read checks and write commit status'
    required: false
    default: ${{ github.token }}

outputs:
  state:
    description: 'pending / success / failure'
  total-checks:
    description: 'Number of check_runs observed before filtering'
  evaluated-checks:
    description: 'Number of check_runs after filtering'
  completed-checks:
    description: 'Number of completed check_runs after filtering'
  mode:
    description: 'normal or rescue'

runs:
  using: 'node24'
  main: 'dist/index.js'
```

- [ ] **Step 2: Commit**

```bash
git add action.yml
git commit -m "feat: add action.yml metadata"
```

---

## Task 3: conclusion 判定 (緑 / 赤 / pending)

**Files:**
- Create: `src/conclusion.ts`, `__tests__/conclusion.test.ts`

- [ ] **Step 1: テストを書く**

`__tests__/conclusion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classify, type CheckRunLike } from "../src/conclusion.js";

const make = (status: string, conclusion: string | null): CheckRunLike =>
  ({ status, conclusion } as CheckRunLike);

describe("classify", () => {
  it("treats success / skipped / neutral as green", () => {
    expect(classify(make("completed", "success"))).toBe("green");
    expect(classify(make("completed", "skipped"))).toBe("green");
    expect(classify(make("completed", "neutral"))).toBe("green");
  });

  it("treats failure / cancelled / timed_out / action_required as red", () => {
    expect(classify(make("completed", "failure"))).toBe("red");
    expect(classify(make("completed", "cancelled"))).toBe("red");
    expect(classify(make("completed", "timed_out"))).toBe("red");
    expect(classify(make("completed", "action_required"))).toBe("red");
  });

  it("treats null conclusion as pending", () => {
    expect(classify(make("completed", null))).toBe("pending");
  });

  it("treats non-completed status as pending", () => {
    expect(classify(make("queued", null))).toBe("pending");
    expect(classify(make("in_progress", null))).toBe("pending");
  });

  it("treats unknown conclusion as red (safe default)", () => {
    expect(classify(make("completed", "stale" as never))).toBe("red");
  });
});
```

- [ ] **Step 2: テストを走らせて fail を確認**

```bash
nr test -- conclusion
```
Expected: FAIL (`Cannot find module '../src/conclusion.js'`)

- [ ] **Step 3: 実装**

`src/conclusion.ts`:

```ts
export type Verdict = "green" | "red" | "pending";

export type CheckRunLike = {
  status: string;
  conclusion: string | null;
};

const GREEN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const RED_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

export const classify = (run: CheckRunLike): Verdict => {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === null) return "pending";
  if (GREEN_CONCLUSIONS.has(run.conclusion)) return "green";
  if (RED_CONCLUSIONS.has(run.conclusion)) return "red";
  return "red";
};
```

- [ ] **Step 4: テスト pass 確認**

```bash
nr test -- conclusion
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/conclusion.ts __tests__/conclusion.test.ts
git commit -m "feat: add check_run conclusion classifier"
```

---

## Task 4: ignore-apps / ignore-checks フィルタ

**Files:**
- Create: `src/filter.ts`, `__tests__/filter.test.ts`

- [ ] **Step 1: テストを書く**

`__tests__/filter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { applyFilters, parseList, type AggregatedCheckRun } from "../src/filter.js";

const make = (
  appSlug: string,
  name: string,
): AggregatedCheckRun => ({
  id: 1,
  name,
  status: "completed",
  conclusion: "success",
  details_url: "",
  app: { slug: appSlug },
  suite_id: 1,
});

describe("parseList", () => {
  it("splits and trims comma-separated values", () => {
    expect(parseList("a, b,c ,")).toEqual(["a", "b", "c"]);
  });
  it("returns empty array for empty / whitespace input", () => {
    expect(parseList("")).toEqual([]);
    expect(parseList("   ")).toEqual([]);
  });
});

describe("applyFilters", () => {
  const runs = [
    make("github-actions", "build"),
    make("dependabot", "dependabot-check"),
    make("github-actions", "optional-flaky"),
    make("github-actions", "docs-only"),
  ];

  it("filters by app slug", () => {
    const result = applyFilters(runs, ["dependabot"], []);
    expect(result.map((r) => r.name)).toEqual([
      "build",
      "optional-flaky",
      "docs-only",
    ]);
  });

  it("filters by check name with glob", () => {
    const result = applyFilters(runs, [], ["optional-*", "docs-only"]);
    expect(result.map((r) => r.name)).toEqual([
      "build",
      "dependabot-check",
    ]);
  });

  it("filters by app and check together (union of exclusions)", () => {
    const result = applyFilters(runs, ["dependabot"], ["optional-*"]);
    expect(result.map((r) => r.name)).toEqual(["build", "docs-only"]);
  });

  it("returns all runs when both filters are empty", () => {
    expect(applyFilters(runs, [], []).length).toBe(4);
  });
});
```

- [ ] **Step 2: テスト fail 確認**

```bash
nr test -- filter
```
Expected: FAIL (module not found)

- [ ] **Step 3: 実装**

`src/filter.ts`:

```ts
import path from "node:path";

export type AggregatedCheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string;
  app: { slug: string };
  suite_id: number;
};

export const parseList = (raw: string): string[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const matchesAnyGlob = (value: string, patterns: string[]): boolean =>
  patterns.some((pattern) => path.matchesGlob(value, pattern));

export const applyFilters = (
  runs: AggregatedCheckRun[],
  ignoreApps: string[],
  ignoreChecks: string[],
): AggregatedCheckRun[] =>
  runs.filter((run) => {
    if (ignoreApps.includes(run.app.slug)) return false;
    if (ignoreChecks.length > 0 && matchesAnyGlob(run.name, ignoreChecks)) {
      return false;
    }
    return true;
  });
```

- [ ] **Step 4: テスト pass 確認**

```bash
nr test -- filter
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/filter.ts __tests__/filter.test.ts
git commit -m "feat: add ignore-apps and ignore-checks filters with glob support"
```

---

## Task 5: 自分自身の除外 (gate workflow の self-job exclusion)

**Files:**
- Create: `src/self-exclusion.ts`, `__tests__/self-exclusion.test.ts`

- [ ] **Step 1: テストを書く**

`__tests__/self-exclusion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractRunId, isOwnRun, RUN_ID_REGEX } from "../src/self-exclusion.js";
import type { AggregatedCheckRun } from "../src/filter.js";

const make = (appSlug: string, detailsUrl: string): AggregatedCheckRun => ({
  id: 1,
  name: "test",
  status: "completed",
  conclusion: "success",
  details_url: detailsUrl,
  app: { slug: appSlug },
  suite_id: 1,
});

describe("RUN_ID_REGEX", () => {
  it("matches the documented details_url shape and asserts on extraction", () => {
    const url = "https://github.com/owner/repo/actions/runs/12345/job/67890";
    const match = url.match(RUN_ID_REGEX);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("12345");
  });

  it("does NOT match unrelated URLs (guards against silent format change)", () => {
    expect(
      "https://github.com/owner/repo/pull/1".match(RUN_ID_REGEX),
    ).toBeNull();
    expect("https://example.com".match(RUN_ID_REGEX)).toBeNull();
  });
});

describe("extractRunId", () => {
  it("returns the numeric run_id from a valid details_url", () => {
    expect(
      extractRunId(
        "https://github.com/owner/repo/actions/runs/42/job/100",
      ),
    ).toBe(42);
  });
  it("returns null for non-matching URLs", () => {
    expect(extractRunId("https://example.com")).toBeNull();
  });
});

describe("isOwnRun", () => {
  it("flags github-actions check_runs whose run_id matches GITHUB_RUN_ID", () => {
    const run = make(
      "github-actions",
      "https://github.com/owner/repo/actions/runs/9999/job/1",
    );
    expect(isOwnRun(run, 9999)).toBe(true);
  });

  it("does not flag check_runs from other apps even if URL contains the same run_id", () => {
    const run = make(
      "cloudflare-pages",
      "https://github.com/owner/repo/actions/runs/9999/job/1",
    );
    expect(isOwnRun(run, 9999)).toBe(false);
  });

  it("does not flag check_runs with different run_id", () => {
    const run = make(
      "github-actions",
      "https://github.com/owner/repo/actions/runs/1/job/1",
    );
    expect(isOwnRun(run, 9999)).toBe(false);
  });

  it("does not flag check_runs with malformed details_url", () => {
    const run = make("github-actions", "https://example.com");
    expect(isOwnRun(run, 9999)).toBe(false);
  });
});
```

- [ ] **Step 2: テスト fail 確認**

```bash
nr test -- self-exclusion
```
Expected: FAIL

- [ ] **Step 3: 実装**

`src/self-exclusion.ts`:

```ts
import type { AggregatedCheckRun } from "./filter.js";

export const RUN_ID_REGEX = /\/actions\/runs\/(\d+)\/job\/\d+/;

export const extractRunId = (detailsUrl: string): number | null => {
  const match = detailsUrl.match(RUN_ID_REGEX);
  if (match === null) return null;
  return Number.parseInt(match[1], 10);
};

export const isOwnRun = (
  run: AggregatedCheckRun,
  ownRunId: number,
): boolean => {
  if (run.app.slug !== "github-actions") return false;
  const runId = extractRunId(run.details_url);
  return runId === ownRunId;
};

export const excludeOwnRuns = (
  runs: AggregatedCheckRun[],
  ownRunId: number,
): AggregatedCheckRun[] => runs.filter((r) => !isOwnRun(r, ownRunId));
```

- [ ] **Step 4: テスト pass 確認**

```bash
nr test -- self-exclusion
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/self-exclusion.ts __tests__/self-exclusion.test.ts
git commit -m "feat: exclude gate workflow's own check_runs via details_url"
```

---

## Task 6: octokit API wrapper (retry / pagination)

**Files:**
- Create: `src/api.ts`, `__tests__/api.test.ts`

- [ ] **Step 1: テストを書く**

`__tests__/api.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchAllCheckRuns, type OctokitLike } from "../src/api.js";

describe("fetchAllCheckRuns", () => {
  it("fetches suites and flattens runs across pages", async () => {
    const listSuites = vi.fn().mockResolvedValueOnce({
      data: {
        check_suites: [
          { id: 1, app: { slug: "github-actions" } },
          { id: 2, app: { slug: "cloudflare-pages" } },
        ],
      },
    });
    const listForSuite = vi.fn(async ({ check_suite_id }: { check_suite_id: number }) => ({
      data: {
        check_runs: [
          {
            id: check_suite_id * 10,
            name: `suite-${check_suite_id}-run`,
            status: "completed",
            conclusion: "success",
            details_url: "",
          },
        ],
      },
    }));

    const octokit: OctokitLike = {
      rest: {
        checks: {
          listSuitesForRef: listSuites,
          listForSuite,
        },
      },
      paginate: async (fn: unknown, params: unknown) => {
        const res = await (fn as (p: unknown) => Promise<{ data: unknown }>)(params);
        const data = (res as { data: { check_suites?: unknown[]; check_runs?: unknown[] } }).data;
        return data.check_suites ?? data.check_runs ?? [];
      },
    } as unknown as OctokitLike;

    const result = await fetchAllCheckRuns(octokit, "owner", "repo", "abc");
    expect(result).toHaveLength(2);
    expect(result[0].suite_id).toBe(1);
    expect(result[1].suite_id).toBe(2);
    expect(result[0].app.slug).toBe("github-actions");
    expect(result[1].app.slug).toBe("cloudflare-pages");
  });
});
```

- [ ] **Step 2: テスト fail 確認**

```bash
nr test -- api
```
Expected: FAIL

- [ ] **Step 3: 実装**

`src/api.ts`:

```ts
import type { AggregatedCheckRun } from "./filter.js";

export type OctokitLike = {
  rest: {
    checks: {
      listSuitesForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        per_page?: number;
      }) => Promise<{ data: { check_suites: CheckSuiteData[] } }>;
      listForSuite: (params: {
        owner: string;
        repo: string;
        check_suite_id: number;
        per_page?: number;
      }) => Promise<{ data: { check_runs: CheckRunData[] } }>;
    };
    repos: {
      createCommitStatus: (params: {
        owner: string;
        repo: string;
        sha: string;
        state: "pending" | "success" | "failure";
        context: string;
        description?: string;
        target_url?: string;
      }) => Promise<unknown>;
    };
  };
  paginate: <T>(
    fn: (params: Record<string, unknown>) => Promise<{ data: T[] }>,
    params: Record<string, unknown>,
  ) => Promise<T[]>;
};

type CheckSuiteData = {
  id: number;
  app: { slug: string } | null;
  status: string;
};

type CheckRunData = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string;
};

export const fetchAllCheckRuns = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  sha: string,
): Promise<AggregatedCheckRun[]> => {
  const suites = await octokit.paginate<CheckSuiteData>(
    octokit.rest.checks.listSuitesForRef as never,
    { owner, repo, ref: sha, per_page: 100 },
  );

  const runs: AggregatedCheckRun[] = [];
  for (const suite of suites) {
    const slug = suite.app?.slug ?? "unknown";
    const suiteRuns = await octokit.paginate<CheckRunData>(
      octokit.rest.checks.listForSuite as never,
      { owner, repo, check_suite_id: suite.id, per_page: 100 },
    );
    for (const r of suiteRuns) {
      runs.push({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        details_url: r.details_url,
        app: { slug },
        suite_id: suite.id,
      });
    }
  }
  return runs;
};

export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: { retries: number; baseDelayMs: number },
): Promise<T> => {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      if (status !== undefined && status < 500) throw err;
      if (attempt === options.retries) throw err;
      const delay = options.baseDelayMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
};

export const waitForTriggerSuiteCompleted = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  sha: string,
  triggerSuiteId: number,
  options: { attempts: number; delayMs: number } = { attempts: 5, delayMs: 2000 },
): Promise<boolean> => {
  for (let i = 0; i < options.attempts; i++) {
    const { data } = await octokit.rest.checks.listSuitesForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    const trigger = data.check_suites.find((s) => s.id === triggerSuiteId);
    if (trigger && trigger.status === "completed") return true;
    if (i < options.attempts - 1) {
      await new Promise((r) => setTimeout(r, options.delayMs));
    }
  }
  return false;
};
```

- [ ] **Step 4: テスト pass 確認**

```bash
nr test -- api
```
Expected: PASS

- [ ] **Step 5: withRetry / waitForTriggerSuiteCompleted のテストを追加**

`__tests__/api.test.ts` に追記:

```ts
import { withRetry, waitForTriggerSuiteCompleted } from "../src/api.js";

describe("withRetry", () => {
  it("returns the value on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { retries: 3, baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx errors", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValue("ok");
    expect(await withRetry(fn, { retries: 3, baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 4xx errors", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 404 });
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).rejects.toEqual({
      status: 404,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 });
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toEqual({
      status: 503,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("waitForTriggerSuiteCompleted", () => {
  it("returns true once the trigger suite is completed", async () => {
    const listSuites = vi
      .fn()
      .mockResolvedValueOnce({
        data: { check_suites: [{ id: 1, app: { slug: "x" }, status: "in_progress" }] },
      })
      .mockResolvedValueOnce({
        data: { check_suites: [{ id: 1, app: { slug: "x" }, status: "completed" }] },
      });
    const octokit = {
      rest: { checks: { listSuitesForRef: listSuites } },
    } as unknown as OctokitLike;
    const ok = await waitForTriggerSuiteCompleted(octokit, "o", "r", "sha", 1, {
      attempts: 3,
      delayMs: 1,
    });
    expect(ok).toBe(true);
    expect(listSuites).toHaveBeenCalledTimes(2);
  });

  it("returns false if it never completes within the budget", async () => {
    const listSuites = vi.fn().mockResolvedValue({
      data: { check_suites: [{ id: 1, app: { slug: "x" }, status: "in_progress" }] },
    });
    const octokit = {
      rest: { checks: { listSuitesForRef: listSuites } },
    } as unknown as OctokitLike;
    const ok = await waitForTriggerSuiteCompleted(octokit, "o", "r", "sha", 1, {
      attempts: 2,
      delayMs: 1,
    });
    expect(ok).toBe(false);
    expect(listSuites).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: テスト pass 確認**

```bash
nr test -- api
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/api.ts __tests__/api.test.ts
git commit -m "feat: add octokit wrapper with pagination and retry helpers"
```

---

## Task 7: aggregator (mode 分岐)

**Files:**
- Create: `src/aggregator.ts`, `__tests__/aggregator.test.ts`

- [ ] **Step 1: テストを書く**

`__tests__/aggregator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { aggregate, type AggregateResult } from "../src/aggregator.js";
import type { AggregatedCheckRun } from "../src/filter.js";

const make = (
  override: Partial<AggregatedCheckRun> = {},
): AggregatedCheckRun => ({
  id: 1,
  name: "x",
  status: "completed",
  conclusion: "success",
  details_url: "",
  app: { slug: "github-actions" },
  suite_id: 1,
  ...override,
});

describe("aggregate (normal mode)", () => {
  it("writes pending if any check_run is not completed", () => {
    const result = aggregate({
      runs: [make(), make({ status: "in_progress", conclusion: null })],
      mode: "normal",
    });
    expect(result.state).toBe("pending");
    expect(result.mode).toBe("normal");
  });

  it("writes success if all check_runs are green", () => {
    const result = aggregate({
      runs: [
        make({ conclusion: "success" }),
        make({ conclusion: "skipped" }),
        make({ conclusion: "neutral" }),
      ],
      mode: "normal",
    });
    expect(result.state).toBe("success");
  });

  it("writes failure if any check_run is red", () => {
    const result = aggregate({
      runs: [make({ conclusion: "success" }), make({ conclusion: "failure" })],
      mode: "normal",
    });
    expect(result.state).toBe("failure");
  });

  it("writes success when there are zero runs (vacuous)", () => {
    const result = aggregate({ runs: [], mode: "normal" });
    expect(result.state).toBe("success");
  });
});

describe("aggregate (rescue mode)", () => {
  it("ignores in_progress runs and evaluates the rest", () => {
    const result = aggregate({
      runs: [
        make({ conclusion: "success" }),
        make({ status: "in_progress", conclusion: null }),
      ],
      mode: "rescue",
    });
    expect(result.state).toBe("success");
    expect(result.mode).toBe("rescue");
  });

  it("still fails if any completed run is red", () => {
    const result = aggregate({
      runs: [
        make({ conclusion: "failure" }),
        make({ status: "in_progress", conclusion: null }),
      ],
      mode: "rescue",
    });
    expect(result.state).toBe("failure");
  });

  it("writes success when only in_progress runs remain", () => {
    const result = aggregate({
      runs: [make({ status: "in_progress", conclusion: null })],
      mode: "rescue",
    });
    expect(result.state).toBe("success");
  });
});

describe("aggregate counts", () => {
  it("reports total / completed counts", () => {
    const result: AggregateResult = aggregate({
      runs: [
        make({ conclusion: "success" }),
        make({ status: "in_progress", conclusion: null }),
      ],
      mode: "normal",
    });
    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
  });
});
```

- [ ] **Step 2: テスト fail 確認**

```bash
nr test -- aggregator
```
Expected: FAIL

- [ ] **Step 3: 実装**

`src/aggregator.ts`:

```ts
import { classify } from "./conclusion.js";
import type { AggregatedCheckRun } from "./filter.js";

export type Mode = "normal" | "rescue";
export type State = "pending" | "success" | "failure";

export type AggregateInput = {
  runs: AggregatedCheckRun[];
  mode: Mode;
};

export type AggregateResult = {
  state: State;
  mode: Mode;
  total: number;
  completed: number;
};

export const aggregate = (input: AggregateInput): AggregateResult => {
  const { runs, mode } = input;
  const total = runs.length;
  const completed = runs.filter((r) => r.status === "completed").length;

  if (mode === "normal") {
    const anyPending = runs.some((r) => classify(r) === "pending");
    if (anyPending) {
      return { state: "pending", mode, total, completed };
    }
  }

  const consideredRuns =
    mode === "rescue"
      ? runs.filter((r) => r.status === "completed")
      : runs;

  const anyRed = consideredRuns.some((r) => classify(r) === "red");
  if (anyRed) return { state: "failure", mode, total, completed };

  return { state: "success", mode, total, completed };
};
```

- [ ] **Step 4: テスト pass 確認**

```bash
nr test -- aggregator
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.ts __tests__/aggregator.test.ts
git commit -m "feat: add aggregator with normal/rescue mode branch"
```

---

## Task 8: commit status writer (target_url 組み立て + retry)

**Files:**
- Create: `src/status.ts`, `__tests__/status.test.ts`

- [ ] **Step 1: テストを書く**

`__tests__/status.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildTargetUrl, writeCommitStatus } from "../src/status.js";
import type { OctokitLike } from "../src/api.js";

describe("buildTargetUrl", () => {
  it("composes the run page URL including the run_attempt", () => {
    const url = buildTargetUrl({
      serverUrl: "https://github.com",
      repository: "owner/repo",
      runId: 42,
      runAttempt: 3,
    });
    expect(url).toBe(
      "https://github.com/owner/repo/actions/runs/42/attempts/3",
    );
  });
});

describe("writeCommitStatus", () => {
  it("posts a commit status with state, context, and target_url", async () => {
    const create = vi.fn().mockResolvedValue({});
    const octokit = {
      rest: { repos: { createCommitStatus: create } },
    } as unknown as OctokitLike;

    await writeCommitStatus(octokit, {
      owner: "o",
      repo: "r",
      sha: "abc",
      state: "success",
      context: "check-suite-gate/all-passed",
      description: "All 5 checks passed",
      target_url: "https://example.com",
    });

    expect(create).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      sha: "abc",
      state: "success",
      context: "check-suite-gate/all-passed",
      description: "All 5 checks passed",
      target_url: "https://example.com",
    });
  });

  it("retries on 5xx errors", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValue({});
    const octokit = {
      rest: { repos: { createCommitStatus: create } },
    } as unknown as OctokitLike;

    await writeCommitStatus(
      octokit,
      {
        owner: "o",
        repo: "r",
        sha: "abc",
        state: "success",
        context: "ctx",
      },
      { retries: 3, baseDelayMs: 1 },
    );
    expect(create).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: テスト fail 確認**

```bash
nr test -- status
```
Expected: FAIL

- [ ] **Step 3: 実装**

`src/status.ts`:

```ts
import type { OctokitLike } from "./api.js";
import { withRetry } from "./api.js";
import type { State } from "./aggregator.js";

export type TargetUrlInput = {
  serverUrl: string;
  repository: string;
  runId: number;
  runAttempt: number;
};

export const buildTargetUrl = (input: TargetUrlInput): string =>
  `${input.serverUrl}/${input.repository}/actions/runs/${input.runId}/attempts/${input.runAttempt}`;

export type WriteCommitStatusInput = {
  owner: string;
  repo: string;
  sha: string;
  state: State;
  context: string;
  description?: string;
  target_url?: string;
};

export const writeCommitStatus = async (
  octokit: OctokitLike,
  input: WriteCommitStatusInput,
  retryOptions: { retries: number; baseDelayMs: number } = {
    retries: 3,
    baseDelayMs: 500,
  },
): Promise<void> => {
  await withRetry(
    () => octokit.rest.repos.createCommitStatus(input) as Promise<unknown>,
    retryOptions,
  );
};
```

- [ ] **Step 4: テスト pass 確認**

```bash
nr test -- status
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/status.ts __tests__/status.test.ts
git commit -m "feat: add commit status writer with target_url builder and 5xx retry"
```

---

## Task 9: action input parsing

**Files:**
- Create: `src/inputs.ts`, `__tests__/inputs.test.ts`

- [ ] **Step 1: テストを書く**

`__tests__/inputs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseInputs, type RawInputs } from "../src/inputs.js";

const raw = (override: Partial<RawInputs> = {}): RawInputs => ({
  context: "check-suite-gate/all-passed",
  ignoreApps: "",
  ignoreChecks: "",
  token: "tok",
  ...override,
});

describe("parseInputs", () => {
  it("parses comma lists and trims values", () => {
    const result = parseInputs(
      raw({ ignoreApps: "a, b ,c", ignoreChecks: "*foo, bar-* " }),
    );
    expect(result.ignoreApps).toEqual(["a", "b", "c"]);
    expect(result.ignoreChecks).toEqual(["*foo", "bar-*"]);
  });

  it("uses provided context name", () => {
    expect(parseInputs(raw({ context: "custom/ctx" })).context).toBe(
      "custom/ctx",
    );
  });

  it("requires a non-empty token", () => {
    expect(() => parseInputs(raw({ token: "" }))).toThrow(/token/);
  });
});
```

- [ ] **Step 2: テスト fail 確認**

```bash
nr test -- inputs
```
Expected: FAIL

- [ ] **Step 3: 実装**

`src/inputs.ts`:

```ts
import { parseList } from "./filter.js";

export type RawInputs = {
  context: string;
  ignoreApps: string;
  ignoreChecks: string;
  token: string;
};

export type ParsedInputs = {
  context: string;
  ignoreApps: string[];
  ignoreChecks: string[];
  token: string;
};

export const parseInputs = (raw: RawInputs): ParsedInputs => {
  if (raw.token.trim().length === 0) {
    throw new Error("input `token` must not be empty");
  }
  return {
    context: raw.context,
    ignoreApps: parseList(raw.ignoreApps),
    ignoreChecks: parseList(raw.ignoreChecks),
    token: raw.token,
  };
};
```

- [ ] **Step 4: テスト pass 確認**

```bash
nr test -- inputs
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/inputs.ts __tests__/inputs.test.ts
git commit -m "feat: add action input parser"
```

---

## Task 10: index.ts entry point (組み立て)

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: 実装**

`src/index.ts`:

```ts
import * as core from "@actions/core";
import * as github from "@actions/github";
import { parseInputs } from "./inputs.js";
import { fetchAllCheckRuns, waitForTriggerSuiteCompleted } from "./api.js";
import { applyFilters } from "./filter.js";
import { excludeOwnRuns } from "./self-exclusion.js";
import { aggregate, type Mode } from "./aggregator.js";
import { buildTargetUrl, writeCommitStatus } from "./status.js";

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput("context"),
    ignoreApps: core.getInput("ignore-apps"),
    ignoreChecks: core.getInput("ignore-checks"),
    token: core.getInput("token"),
  });

  const octokit = github.getOctokit(inputs.token);
  const ctx = github.context;
  const eventName = ctx.eventName;
  const runAttempt = Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? "1", 10);
  const runId = Number.parseInt(process.env.GITHUB_RUN_ID ?? "0", 10);
  const serverUrl = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY ?? `${ctx.repo.owner}/${ctx.repo.repo}`;

  const sha =
    eventName === "check_suite"
      ? (ctx.payload.check_suite as { head_sha: string }).head_sha
      : ctx.sha;

  const triggerSuiteId =
    eventName === "check_suite"
      ? (ctx.payload.check_suite as { id: number }).id
      : null;

  if (triggerSuiteId !== null) {
    await waitForTriggerSuiteCompleted(
      octokit as never,
      ctx.repo.owner,
      ctx.repo.repo,
      sha,
      triggerSuiteId,
    );
  }

  const allRuns = await fetchAllCheckRuns(
    octokit as never,
    ctx.repo.owner,
    ctx.repo.repo,
    sha,
  );
  const afterFilters = applyFilters(allRuns, inputs.ignoreApps, inputs.ignoreChecks);
  const afterSelf = excludeOwnRuns(afterFilters, runId);

  const mode: Mode = runAttempt > 1 ? "rescue" : "normal";
  const result = aggregate({ runs: afterSelf, mode });

  const targetUrl = buildTargetUrl({
    serverUrl,
    repository,
    runId,
    runAttempt,
  });

  const description =
    result.state === "pending"
      ? `Waiting on ${afterSelf.length - result.completed} of ${afterSelf.length} checks`
      : `${result.state}: ${afterSelf.length} checks evaluated (mode=${mode})`;

  await writeCommitStatus(octokit as never, {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    sha,
    state: result.state,
    context: inputs.context,
    description: description.slice(0, 140),
    target_url: targetUrl,
  });

  core.setOutput("state", result.state);
  core.setOutput("total-checks", String(allRuns.length));
  core.setOutput("evaluated-checks", String(afterSelf.length));
  core.setOutput("completed-checks", String(result.completed));
  core.setOutput("mode", mode);
};

run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message);
  } else {
    core.setFailed(String(err));
  }
});
```

- [ ] **Step 2: typecheck**

```bash
nr typecheck
```
Expected: PASS

- [ ] **Step 3: 全テスト走らせて pass 確認**

```bash
nr test
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up entry point (input parse, aggregator, status write)"
```

---

## Task 11: dist/index.js を bundle して commit

**Files:**
- Create: `dist/index.js` (bundle 結果)

- [ ] **Step 1: build**

```bash
nr build
```
Expected: `dist/index.js` が生成される

- [ ] **Step 2: bundle した内容を確認**

```bash
ls -la dist/index.js
head -20 dist/index.js
```

- [ ] **Step 3: Commit**

```bash
git add dist/index.js
git commit -m "build: bundle dist/index.js"
```

---

## Task 12: CI workflow (.github/workflows/ci.yml)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: ci.yml を作成**

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build
      - name: Verify dist/ is up to date
        run: |
          if [ -n "$(git status --porcelain dist/)" ]; then
            echo "::error::dist/ is out of sync. Run 'npm run build' and commit the result."
            git diff dist/
            exit 1
          fi
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add lint/typecheck/test/build/dist-check workflow"
```

---

## Task 13: self-hosting integration test workflow

**Files:**
- Create: `.github/workflows/test-self.yml`

- [ ] **Step 1: test-self.yml を作成**

`.github/workflows/test-self.yml`:

```yaml
name: test-self

on:
  check_suite:
    types: [completed]

permissions:
  statuses: write
  checks: read
  pull-requests: read
  actions: read

concurrency:
  group: gate-${{ github.event.check_suite.head_sha }}
  cancel-in-progress: false

jobs:
  aggregate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
      - run: npm ci
      - run: npm run build
      - name: Self-host gate
        uses: ./
        with:
          context: 'check-suite-gate/self-test'
          ignore-checks: 'check-suite-gate/self-test'
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test-self.yml
git commit -m "ci: add self-hosting integration test workflow"
```

---

## Task 14: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README (English)**

`README.md`:

````markdown
# check-suite-gate

A GitHub Action that aggregates all check results on the same commit into a single commit status, triggered by `check_suite.completed`. Designed as a **multi-workflow successor to `re-actors/alls-green`** for monorepo + Renovate environments, replacing `upsidr/merge-gatekeeper`'s polling-based design that occupies a runner for the entire CI duration.

## Usage

```yaml
# .github/workflows/check-suite-gate.yaml
name: check-suite-gate

on:
  check_suite:
    types: [completed]

permissions:
  statuses: write
  checks: read
  pull-requests: read
  actions: read

concurrency:
  group: gate-${{ github.event.check_suite.head_sha }}
  cancel-in-progress: false

jobs:
  aggregate:
    runs-on: ubuntu-latest
    steps:
      - uses: pkgdeps/check-suite-gate@v1
        with:
          context: 'check-suite-gate/all-passed'
          ignore-apps: 'dependabot[bot]'
          ignore-checks: 'optional-*,docs-only'
```

Then register `check-suite-gate/all-passed` as a required status check in your ruleset / branch protection.

## Inputs

| name | required | default | description |
|---|---|---|---|
| `context` | no | `check-suite-gate/all-passed` | Commit status context name |
| `ignore-apps` | no | (empty) | Comma-separated GitHub App slugs whose check_runs are excluded |
| `ignore-checks` | no | (empty) | Comma-separated check_run name patterns to exclude. Glob (`*` / `?`) supported |
| `token` | no | `${{ github.token }}` | GitHub token used for API access |

## Outputs

| name | description |
|---|---|
| `state` | `pending` / `success` / `failure` |
| `total-checks` | Number of check_runs observed before filtering |
| `evaluated-checks` | Number of check_runs after filters |
| `completed-checks` | Number of completed check_runs after filters |
| `mode` | `normal` or `rescue` |

## Rescue Mode (Recovering from Stuck Status)

When the aggregated status is stuck on `pending` (e.g. a third-party GitHub App never reports back), click the aggregated status in the PR's Checks UI. This opens the gate workflow's run page where you can press **"Re-run all jobs"**. With `run_attempt > 1`, the action enters rescue mode: incomplete check_runs are excluded from aggregation, and the verdict is decided based on the remaining ones.

## Design

See `docs/superpowers/specs/2026-05-05-check-suite-gate-design.md` for the full design document.

## License

MIT
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Task 15: 最終確認 / push

- [ ] **Step 1: 全 lint / typecheck / test / build を流す**

```bash
nr all
```
Expected: 全 PASS

- [ ] **Step 2: dist/ の整合性を確認**

```bash
git status --porcelain dist/
```
Expected: 空 (差分なし)

- [ ] **Step 3: push**

```bash
git push origin design-spec
```

- [ ] **Step 4: PR を作成**

```bash
gh pr create --base main --title "feat: implement check-suite-gate v1" --body-file - <<'EOF'
## Summary

`check_suite.completed` を起点に同 SHA の全 check_run を集約して 1 つの commit status を書く GitHub Action の v1 実装。

設計仕様: `docs/superpowers/specs/2026-05-05-check-suite-gate-design.md`

## Test plan

- [ ] CI (lint / typecheck / test / build / dist check) が green
- [ ] self-hosting test (test-self.yml) で実 PR に集約 status が書かれる
- [ ] stuck したら "Re-run all jobs" で救出モードが起動することを確認
EOF
```

---

## Self-Review Notes

### Spec coverage

- [x] check_suite.completed event 駆動 → Task 10 (index.ts), Task 13 (利用者 yaml + self-hosting)
- [x] listSuitesForRef + listForSuite で check_run 取得 → Task 6 (api.ts)
- [x] ignore-apps / ignore-checks フィルタ (glob) → Task 4 (filter.ts)
- [x] 自分自身の除外 → Task 5 (self-exclusion.ts)
- [x] 通常モード / 救出モード分岐 (run_attempt) → Task 7 (aggregator.ts), Task 10 (index.ts)
- [x] conclusion 評価 (success/skipped/neutral 緑、 残り赤、 null pending) → Task 3 (conclusion.ts)
- [x] commit status の target_url を current run page に → Task 8 (status.ts), Task 10
- [x] race 対策 concurrency → Task 13 (利用者 yaml に書く)
- [x] eventual consistency retry (5x2s) → Task 6 (api.ts: waitForTriggerSuiteCompleted)
- [x] 5xx exponential backoff retry (3 回) → Task 6 (api.ts: withRetry), Task 8
- [x] runs.using: node24 → Task 2
- [x] @octokit/rest / @actions/core / @actions/github 使用 → Task 1 (依存) / Task 10
- [x] vitest unit test → Task 3-9
- [x] self-hosting integration → Task 13
- [x] dist commit + CI 整合性チェック → Task 11 / Task 12
- [x] action.yml inputs/outputs → Task 2
- [x] README → Task 14

### 注記

- v1 では `success-conclusions` / `required-apps` / `required-checks` は実装しない (spec 通り)
- `script/release` は Task 1 で template から取り込んだ。 maintainer が手元で実行する想定で本 plan には実行 task は含めない (initial release は別タイミング)
- self-exclusion.test.ts に regex の format guard を含めた (advisor 助言: details_url format が変わった際に CI で気付ける)
