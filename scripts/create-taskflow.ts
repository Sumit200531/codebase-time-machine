/**
 * Builds TaskFlow: a synthetic but *real* Git repository used as the demo.
 *
 * Every commit, merge, rename and tag is created with Git, then analyzed by
 * the same pipeline as any imported repository. The people are fictional
 * and the bundle carries a visible demo notice.
 *
 *   npm run demo:build            -> packages/web/src/data/taskflow.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBundle } from "@ctm/export";
import { FixtureRepo, seededRandom, type Identity } from "../test-support/fixture-repo.ts";

const PRIYA: Identity = { name: "Priya Sharma", email: "priya@taskflow.dev" };
const RAHUL: Identity = { name: "Rahul Verma", email: "rahul@taskflow.dev" };
const AMAN: Identity = { name: "Aman Gupta", email: "aman@taskflow.dev" };
const ELENA: Identity = { name: "Elena Petrova", email: "elena@taskflow.dev" };
const KENJI: Identity = { name: "Kenji Watanabe", email: "kenji@taskflow.dev" };
const MAYA: Identity = { name: "Maya Okafor", email: "maya@taskflow.dev" };

const OUTPUT = join(import.meta.dirname, "..", "packages", "web", "src", "data", "taskflow.json");
export const DEMO_NOTICE =
  "Demo repository: TaskFlow is a synthetic project with fictional contributors, generated as real Git history and analyzed by the same pipeline as imported repositories.";

const random = seededRandom(2024);
const repo = FixtureRepo.create("taskflow-");
const DAY = 24;

/** Days between commits vary so the timeline has realistic gaps and bursts. */
function later(minDays: number, maxDays: number): number {
  return Math.round((minDays + random() * (maxDays - minDays)) * DAY);
}

/** A plausible ES module with the given imports and exported functions. */
function mod(imports: Record<string, string>, fns: string[], extra = ""): string {
  const head = Object.entries(imports).map(([name, from]) => `import ${name} from "${from}";`).join("\n");
  const body = fns
    .map(
      (fn) =>
        `export async function ${fn}(input = {}) {\n  const started = Date.now();\n  const result = { ...input, handledBy: "${fn}" };\n  log("${fn}", Date.now() - started);\n  return result;\n}`,
    )
    .join("\n\n");
  return `${head}${head ? "\n\n" : ""}const log = (name, ms) => console.debug(\`[\${name}] \${ms}ms\`);\n\n${body}\n${extra}`;
}

function edit(path: string, fn: string): void {
  const current = readFileSync(join(repo.dir, path), "utf8");
  repo.write(path, `${current}\nexport function ${fn}(value) {\n  if (value == null) return null;\n  return { value, at: Date.now() };\n}\n`);
}

function commit(message: string, author: Identity, min = 2, max = 9): void {
  repo.commit(message, author, { hoursLater: later(min, max) });
}

function maintenance(count: number, files: readonly string[], authors: readonly Identity[]): void {
  const verbs = ["Fix edge case in", "Refine", "Improve error handling in", "Simplify", "Add validation to", "Tidy"];
  for (let i = 0; i < count; i++) {
    const file = files[Math.floor(random() * files.length)]!;
    edit(file, `helper${Math.floor(random() * 1e5)}`);
    const name = file.split("/").pop()!.replace(/\.\w+$/, "");
    commit(`${verbs[Math.floor(random() * verbs.length)]} ${name}`, authors[Math.floor(random() * authors.length)]!, 1, 6);
  }
}

// ── Era 1: Initial project ─────────────────────────────────────────────
repo
  .write("README.md", "# TaskFlow\n\nA tiny task manager.\n")
  .write("package.json", JSON.stringify({ name: "taskflow", version: "0.1.0", type: "module" }, null, 2) + "\n")
  .write("src/utils.js", mod({}, ["formatDate", "slugify"]))
  .write("src/main.js", mod({ utils: "./utils.js" }, ["main"]));
commit("Initial project", PRIYA, 0, 1);
repo.git("tag", "v0.1-initial");
maintenance(3, ["src/main.js", "src/utils.js"], [PRIYA]);

// ── Era 2: Basic frontend ──────────────────────────────────────────────
repo
  .write("frontend/index.html", "<!doctype html>\n<html>\n<body>\n<div id=\"app\"></div>\n<script type=\"module\" src=\"./app.js\"></script>\n</body>\n</html>\n")
  .write("frontend/components/TaskItem.js", mod({}, ["TaskItem"]))
  .write("frontend/components/TaskList.js", mod({ TaskItem: "./TaskItem.js" }, ["TaskList"]))
  .write("frontend/app.js", mod({ TaskList: "./components/TaskList.js" }, ["mount"]))
  .write("frontend/styles.css", "body {\n  font-family: system-ui;\n  margin: 0;\n}\n");
commit("Add basic frontend with task list", RAHUL);
repo.git("tag", "v0.2-frontend");
maintenance(4, ["frontend/app.js", "frontend/components/TaskList.js", "frontend/components/TaskItem.js"], [RAHUL, PRIYA]);

// ── Era 3: Backend introduced (branch + moves) ─────────────────────────
repo.checkout("feature/backend", true);
repo.move("src/main.js", "backend/server.js");
repo.move("src/utils.js", "backend/utils.js");
repo.write("backend/server.js", mod({ express: "express", utils: "./utils.js" }, ["main", "listen"]));
commit("Move core into a backend service", PRIYA);
repo.write("frontend/api.js", mod({}, ["fetchTasks", "createTask"]));
repo.write("frontend/app.js", mod({ TaskList: "./components/TaskList.js", api: "./api.js" }, ["mount", "refresh"]));
commit("Connect frontend to backend", RAHUL);
repo.checkout("main");
repo.merge("feature/backend", "Merge feature/backend", PRIYA);
repo.git("tag", "v0.3-backend");
maintenance(3, ["backend/server.js", "frontend/api.js"], [PRIYA, RAHUL]);

// ── Era 4: Database ────────────────────────────────────────────────────
repo
  .write("backend/db/connection.js", mod({ pg: "pg" }, ["connect", "query"]))
  .write("backend/db/migrations/001_tasks.sql", "CREATE TABLE tasks (\n  id serial PRIMARY KEY,\n  title text NOT NULL,\n  done boolean NOT NULL DEFAULT false\n);\n")
  .write("backend/models/task.js", mod({ db: "../db/connection.js" }, ["findAll", "create", "complete"]))
  .write("backend/server.js", mod({ express: "express", utils: "./utils.js", Task: "./models/task.js" }, ["main", "listen"]));
commit("Add PostgreSQL persistence for tasks", AMAN);
repo.git("tag", "v0.4-database");
maintenance(4, ["backend/models/task.js", "backend/db/connection.js"], [AMAN, PRIYA]);

// ── Era 5: Authentication (branch) ─────────────────────────────────────
repo.checkout("feature/auth", true);
repo
  .write("backend/models/user.js", mod({ db: "../db/connection.js" }, ["findByEmail", "createUser"]))
  .write("backend/db/migrations/002_users.sql", "CREATE TABLE users (\n  id serial PRIMARY KEY,\n  email text UNIQUE NOT NULL,\n  password_hash text NOT NULL\n);\n")
  .write("backend/auth/tokens.js", mod({ jwt: "jsonwebtoken" }, ["sign", "verify"]));
commit("Add user model and token helpers", ELENA);
repo
  .write("backend/auth/login.js", mod({ bcrypt: "bcrypt", User: "../models/user.js", tokens: "./tokens.js" }, ["login", "register"]))
  .write("backend/auth/middleware.js", mod({ tokens: "./tokens.js" }, ["requireAuth"]));
commit("Add login flow and auth middleware", ELENA);
repo.checkout("main");
repo.write("frontend/components/TaskItem.js", mod({}, ["TaskItem", "TaskBadge"]));
commit("Show task badges", RAHUL);
repo.merge("feature/auth", "Merge feature/auth", ELENA);
repo.write("frontend/login.js", mod({ api: "./api.js" }, ["LoginForm"]));
commit("Add login screen", RAHUL);
repo.git("tag", "v0.5-auth");
maintenance(5, ["backend/auth/login.js", "backend/auth/tokens.js", "frontend/login.js"], [ELENA, RAHUL]);

// ── Era 6: REST API ────────────────────────────────────────────────────
repo
  .write("backend/api/tasks.js", mod({ Task: "../models/task.js", auth: "../auth/middleware.js" }, ["listTasks", "createTask", "completeTask"]))
  .write("backend/api/users.js", mod({ User: "../models/user.js", auth: "../auth/middleware.js" }, ["me", "updateProfile"]))
  .write("backend/api/router.js", mod({ express: "express", tasks: "./tasks.js", users: "./users.js", login: "../auth/login.js" }, ["buildRouter"]))
  .write("backend/utils/oldCache.js", mod({}, ["memoize"]))
  .write("backend/server.js", mod({ express: "express", router: "./api/router.js" }, ["main", "listen"]));
commit("Introduce versioned REST API", PRIYA);
repo.git("tag", "v0.6-rest-api");
maintenance(5, ["backend/api/tasks.js", "backend/api/users.js", "backend/api/router.js"], [PRIYA, AMAN, ELENA]);

// ── Era 7: Testing ─────────────────────────────────────────────────────
repo
  .write("tests/api/tasks.test.js", mod({ vitest: "vitest", tasks: "../../backend/api/tasks.js" }, ["testListTasks", "testCreateTask"]))
  .write("tests/auth/login.test.js", mod({ vitest: "vitest", login: "../../backend/auth/login.js" }, ["testLogin"]));
commit("Add API and auth test suites", KENJI);
repo.write("tests/models/task.test.js", mod({ vitest: "vitest", Task: "../../backend/models/task.js" }, ["testTaskModel"]));
commit("Cover task model", KENJI);
repo.git("tag", "v0.7-tests");
maintenance(3, ["tests/api/tasks.test.js", "tests/auth/login.test.js"], [KENJI]);

// ── Era 8: The big refactor: monolith → services ───────────────────────
repo.checkout("refactor/services", true);
const moves: [string, string][] = [
  ["backend/auth/login.js", "services/auth/login.js"],
  ["backend/auth/tokens.js", "services/auth/tokens.js"],
  ["backend/auth/middleware.js", "gateway/middleware/auth.js"],
  ["backend/models/user.js", "services/users/model.js"],
  ["backend/api/users.js", "services/users/routes.js"],
  ["backend/models/task.js", "services/tasks/model.js"],
  ["backend/api/tasks.js", "services/tasks/routes.js"],
  ["backend/api/router.js", "gateway/router.js"],
  ["backend/server.js", "gateway/server.js"],
  ["backend/db/connection.js", "database/connection.js"],
  ["backend/db/migrations/001_tasks.sql", "database/migrations/001_tasks.sql"],
  ["backend/db/migrations/002_users.sql", "database/migrations/002_users.sql"],
];
for (const [from, to] of moves) repo.move(from, to);
repo
  .write("services/auth/login.js", mod({ bcrypt: "bcrypt", User: "../users/model.js", tokens: "./tokens.js" }, ["login", "register"]))
  .write("gateway/middleware/auth.js", mod({ tokens: "../../services/auth/tokens.js" }, ["requireAuth"]))
  .write("services/users/model.js", mod({ db: "../../database/connection.js" }, ["findByEmail", "createUser"]))
  .write("services/users/routes.js", mod({ User: "./model.js" }, ["me", "updateProfile"]))
  .write("services/tasks/model.js", mod({ db: "../../database/connection.js" }, ["findAll", "create", "complete"]))
  .write("services/tasks/routes.js", mod({ Task: "./model.js" }, ["listTasks", "createTask", "completeTask"]))
  .write("gateway/router.js", mod({ express: "express", tasks: "../services/tasks/routes.js", users: "../services/users/routes.js", login: "../services/auth/login.js", auth: "./middleware/auth.js" }, ["buildRouter"]))
  .write("gateway/server.js", mod({ express: "express", router: "./router.js" }, ["main", "listen"]))
  .write("tests/api/tasks.test.js", mod({ vitest: "vitest", tasks: "../../services/tasks/routes.js" }, ["testListTasks", "testCreateTask"]))
  .write("tests/auth/login.test.js", mod({ vitest: "vitest", login: "../../services/auth/login.js" }, ["testLogin"]))
  .write("tests/models/task.test.js", mod({ vitest: "vitest", Task: "../../services/tasks/model.js" }, ["testTaskModel"]));
commit("Split monolith into gateway and services", PRIYA, 10, 20);
repo.remove("backend/utils.js").write("shared/format.js", mod({}, ["formatDate", "slugify"]));
commit("Move shared helpers out of the backend", AMAN);
repo.checkout("main");
repo.merge("refactor/services", "Merge refactor/services: service-oriented architecture", PRIYA);
repo.git("tag", "v1.0-services");
maintenance(4, ["gateway/router.js", "services/tasks/routes.js", "services/auth/login.js"], [PRIYA, ELENA, AMAN]);

// ── Era 9: Redis caching ───────────────────────────────────────────────
repo
  .write("services/cache/redis.js", mod({ Redis: "ioredis" }, ["get", "set", "invalidate"]))
  .write("gateway/middleware/cache.js", mod({ cache: "../../services/cache/redis.js" }, ["cacheResponse"]))
  .write("services/tasks/routes.js", mod({ Task: "./model.js", cache: "../cache/redis.js" }, ["listTasks", "createTask", "completeTask"]))
  .remove("backend/utils/oldCache.js");
commit("Improve API caching with Redis", MAYA, 4, 12);
repo.git("tag", "v1.1-caching");
maintenance(3, ["services/cache/redis.js", "gateway/middleware/cache.js"], [MAYA, PRIYA]);

// ── Era 10: Background jobs ────────────────────────────────────────────
repo
  .write("services/jobs/queue.js", mod({ bullmq: "bullmq", cache: "../cache/redis.js" }, ["enqueue", "schedule"]))
  .write("workers/reminders.js", mod({ queue: "../services/jobs/queue.js", Task: "../services/tasks/model.js" }, ["runReminders"]));
commit("Add background job queue and reminder worker", KENJI, 5, 14);
repo.git("tag", "v1.2-jobs");
maintenance(3, ["services/jobs/queue.js", "workers/reminders.js"], [KENJI, MAYA]);

// ── Era 11: Notifications ──────────────────────────────────────────────
repo
  .write("services/notifications/email.js", mod({ nodemailer: "nodemailer" }, ["sendEmail"]))
  .write("services/notifications/push.js", mod({ webpush: "web-push" }, ["sendPush"]))
  .write("services/notifications/index.js", mod({ email: "./email.js", push: "./push.js", User: "../users/model.js" }, ["notify"]))
  .write("workers/reminders.js", mod({ queue: "../services/jobs/queue.js", Task: "../services/tasks/model.js", notify: "../services/notifications/index.js" }, ["runReminders"]));
commit("Add email and push notifications", ELENA, 5, 14);
repo.git("tag", "v1.3-notifications");
maintenance(4, ["services/notifications/index.js", "services/notifications/email.js", "workers/reminders.js"], [ELENA, KENJI, MAYA]);

// ── Era 12: Current architecture ───────────────────────────────────────
for (const file of ["app", "api", "login", "components/TaskList", "components/TaskItem"]) {
  repo.move(`frontend/${file}.js`, `frontend/src/${file}.ts`);
}
repo
  .write("frontend/src/app.ts", mod({ TaskList: "./components/TaskList", api: "./api", login: "./login" }, ["mount", "refresh"]))
  .write("frontend/src/components/TaskList.ts", mod({ TaskItem: "./TaskItem" }, ["TaskList"]))
  .write("frontend/src/login.ts", mod({ api: "./api" }, ["LoginForm"]))
  .write("frontend/index.html", "<!doctype html>\n<html>\n<body>\n<div id=\"app\"></div>\n<script type=\"module\" src=\"./src/app.ts\"></script>\n</body>\n</html>\n");
commit("Migrate frontend to TypeScript", RAHUL, 6, 15);
repo
  .write("infra/docker-compose.yml", "services:\n  gateway:\n    build: .\n  postgres:\n    image: postgres:16\n  redis:\n    image: redis:7\n")
  .write("infra/k8s/gateway.yaml", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: gateway\n")
  .write("infra/k8s/workers.yaml", "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: workers\n");
commit("Add container and Kubernetes infrastructure", MAYA);
repo.git("tag", "v2.0-current");
maintenance(6, ["gateway/router.js", "services/tasks/routes.js", "frontend/src/app.ts", "services/notifications/index.js", "services/cache/redis.js"], [PRIYA, RAHUL, AMAN, ELENA, KENJI, MAYA]);

const bundle = await buildBundle(repo.dir, { label: "TaskFlow", demoNotice: DEMO_NOTICE, onProgress: (m) => console.log(`· ${m}`) });
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(bundle));
const last = bundle.stats.at(-1)!;
console.log(`TaskFlow: ${bundle.steps.length} steps, ${last.files} files, ${last.loc} lines, ${bundle.contributors.length} contributors, ${bundle.milestones.length} milestones, ${bundle.dependencies.length} dependency intervals`);
console.log(`Wrote ${OUTPUT} (${(JSON.stringify(bundle).length / 1024).toFixed(0)} KiB)`);
if (process.argv.includes("--keep")) console.log(`Repository kept at ${repo.dir}`);
else repo.dispose();
