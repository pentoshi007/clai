import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  absorbLooseWorkIntoLedger,
  applyDestinationCwd,
  canMarkTaskDone,
  classifyTaskTitle,
  codingBuildRequiresPlan,
  hasLocalRuntimeProof,
  isBatchSoftFailTool,
  isBuildPrePlanAllowedTool,
  isDevServerCall,
  isFeatureImplementationCall,
  isLongQuietInstallOrScaffoldCommand,
  isPortListeningOutput,
  isReadOnlyVersionProbeCommand,
  isRemoteObservationTask,
  isRuntimeObservationTask,
  isScaffoldCreateCommand,
  isServerReadyOutput,
  looksLikeFeatureProductCode,
  looksLikeStarterBoilerplate,
  openTaskLedger,
  pickPendingTaskForToolCall,
  recordTaskWorkSuccess,
  resolveUserDestinationHint,
  toolFitsTaskClass,
  toolHardBudgetMs,
  toolStallBudgetMs,
  userAskedForFeatureApp,
} from "../src/agent/task-evidence.js";
import {
  ensureCodingPlanFeatureTask,
  ensureCodingPlanInstallTask,
  normalizeCodingPlanTasks,
} from "../src/agent/plan-tool.js";
import {
  buildSessionStateBlock,
  inferNextHint,
  SESSION_STATE_PREFIX,
  upsertSessionStateMessage,
} from "../src/agent/session-state.js";
import { isProjectLocalNodeBin } from "../src/tools/capabilities.js";

describe("task evidence / verify-before-done", () => {
  it("soft-fails plan bookkeeping so batch siblings are not cancelled", () => {
    expect(isBatchSoftFailTool("task.update")).toBe(true);
    expect(isBatchSoftFailTool("plan.create")).toBe(true);
    expect(isBatchSoftFailTool("http.fetch")).toBe(true);
    expect(isBatchSoftFailTool("dns.lookup")).toBe(true);
    expect(isBatchSoftFailTool("fs.write")).toBe(false);
    expect(isBatchSoftFailTool("shell.exec")).toBe(false);
  });

  it("prefers SSRF-related pending task for og-image http.fetch", () => {
    const pending = [
      { id: "t2", title: "Test SSRF with bypass techniques and alternative payloads" },
      { id: "t3", title: "Fuzz API endpoints for hidden parameters and paths" },
      { id: "t4", title: "Test admin authentication for bypass" },
    ];
    const picked = pickPendingTaskForToolCall(pending, {
      name: "http.fetch",
      args: {
        url: "https://aniketpandey.website/api/og-image?url=http://169.254.169.254/",
      },
    });
    expect(picked?.id).toBe("t2");
  });

  it("blocks done without successful work", () => {
    expect(canMarkTaskDone(null, "t1").ok).toBe(false);
    expect(canMarkTaskDone(openTaskLedger("t1"), "t1").ok).toBe(false);
    const led = recordTaskWorkSuccess(openTaskLedger("t1"), "t1", "fs.write");
    expect(canMarkTaskDone(led, "t1").ok).toBe(true);
    expect(canMarkTaskDone(led, "t2").ok).toBe(false);
  });

  it("counts only non-meta tools as evidence", () => {
    let led = openTaskLedger("t1");
    led = recordTaskWorkSuccess(led, "t1", "task.update");
    expect(led?.successWorkCount).toBe(0);
    led = recordTaskWorkSuccess(led, "t1", "shell.exec");
    expect(led?.successWorkCount).toBe(1);
  });

  it("classifies check node/npm availability as explore", () => {
    expect(classifyTaskTitle("Check Node.js and npm availability")).toBe(
      "explore",
    );
    expect(classifyTaskTitle("Verify tools present")).toBe("explore");
  });

  it("absorbs preflight tool.check into explore tasks for done gate", () => {
    const title = "Check Node.js and npm availability";
    expect(toolFitsTaskClass("tool.check", title)).toBe(true);
    expect(toolFitsTaskClass("tool.check", "Create React project with Vite")).toBe(
      false,
    );
    const led = absorbLooseWorkIntoLedger(null, "t1", title, [
      { toolName: "tool.check" },
    ]);
    expect(led?.successWorkCount).toBe(1);
    expect(canMarkTaskDone(led, "t1", { taskTitle: title }).ok).toBe(true);
  });

  it("does not let tool.check alone complete an install task", () => {
    const title = "Install dependencies (npm install)";
    const led = absorbLooseWorkIntoLedger(null, "t3", title, [
      { toolName: "tool.check" },
    ]);
    // No install signal → still blocked by install gate or empty absorb
    const count = led?.successWorkCount ?? 0;
    if (count > 0) {
      expect(
        canMarkTaskDone(led, "t3", { taskTitle: title }).ok,
      ).toBe(false);
    } else {
      expect(canMarkTaskDone(led, "t3", { taskTitle: title }).ok).toBe(false);
    }
  });
});

describe("dev server and scaffold classification", () => {
  it("does not classify npm create vite as a dev server", () => {
    const cmd =
      "npm create vite@latest /Users/aniketpandey/Desktop/todo-app -- --template react";
    expect(isScaffoldCreateCommand(cmd)).toBe(true);
    expect(
      isDevServerCall({ name: "shell.exec", args: { command: cmd } }),
    ).toBe(false);
  });

  it("treats cargo new / rails new as scaffolders not dev servers", () => {
    for (const cmd of ["cargo new myapp", "rails new blog", "poetry new svc"]) {
      expect(isScaffoldCreateCommand(cmd)).toBe(true);
      expect(
        isDevServerCall({ name: "shell.exec", args: { command: cmd } }),
      ).toBe(false);
    }
  });

  it("still treats bare vite / npm run dev as dev server", () => {
    expect(
      isDevServerCall({
        name: "shell.exec",
        args: { command: "npm run dev" },
      }),
    ).toBe(true);
    expect(
      isDevServerCall({ name: "shell.exec", args: { command: "vite" } }),
    ).toBe(true);
  });
});

describe("desktop destination hint", () => {
  it("resolves desktop directory phrasing", () => {
    const desk = join(homedir(), "Desktop");
    expect(
      resolveUserDestinationHint("create a react todo app in desktop directory"),
    ).toBe(desk);
    expect(
      resolveUserDestinationHint("build a vite app on the desktop"),
    ).toBe(desk);
  });

  it("applies cwd to scaffold/install when omitted", () => {
    const desk = join(homedir(), "Desktop");
    const call = applyDestinationCwd(
      {
        name: "shell.exec",
        args: {
          command: "npx create-vite@latest react-todo-app --template react",
        },
      },
      desk,
    );
    expect(call.args.cwd).toBe(desk);
  });

  it("does not override explicit cwd", () => {
    const call = applyDestinationCwd(
      {
        name: "shell.exec",
        args: { command: "npm install", cwd: "/tmp/app" },
      },
      join(homedir(), "Desktop"),
    );
    expect(call.args.cwd).toBe("/tmp/app");
  });
});

describe("coding plan requirement helpers", () => {
  it("detects feature apps and pre-plan tools", () => {
    expect(userAskedForFeatureApp("create a nextjs todo app in desktop")).toBe(
      true,
    );
    expect(userAskedForFeatureApp("just scaffold a blank next app")).toBe(
      false,
    );
    expect(isBuildPrePlanAllowedTool("fs.list")).toBe(true);
    expect(isBuildPrePlanAllowedTool("plan.create")).toBe(true);
    expect(isBuildPrePlanAllowedTool("web.search")).toBe(true);
    expect(isBuildPrePlanAllowedTool("shell.exec")).toBe(false);
    expect(isReadOnlyVersionProbeCommand("node -v")).toBe(true);
    expect(isReadOnlyVersionProbeCommand("npm create vite@latest x")).toBe(
      false,
    );
    expect(
      codingBuildRequiresPlan("create a react todo app", {
        informational: false,
        idle: false,
        pentest: false,
      }),
    ).toBe(true);
  });

  it("uses the universal default and honors model-selected tool timeouts", () => {
    expect(
      isLongQuietInstallOrScaffoldCommand(
        "npx create-next-app@latest /tmp/x --yes",
      ),
    ).toBe(true);
    expect(isLongQuietInstallOrScaffoldCommand("npm install")).toBe(true);
    expect(isLongQuietInstallOrScaffoldCommand("ls -la")).toBe(false);

    const defaultCalls = [
      { name: "shell.exec", args: { command: "echo ok" } },
      { name: "web.search", args: { query: "x" } },
      { name: "web.fetch", args: { url: "https://x" } },
    ];
    for (const call of defaultCalls) {
      expect(toolStallBudgetMs(call)).toBe(42_500);
      expect(toolHardBudgetMs(call)).toBe(42_500);
    }

    const automaticLong = {
      name: "shell.exec",
      args: { command: "npm install" },
    };
    expect(toolStallBudgetMs(automaticLong)).toBe(15 * 60_000 + 2_500);
    expect(toolHardBudgetMs(automaticLong)).toBe(15 * 60_000 + 2_500);

    const selected = {
      name: "shell.exec",
      args: { command: "npm install", timeoutMs: 12 * 60_000 },
    };
    expect(toolStallBudgetMs(selected)).toBe(12 * 60_000 + 2_500);
    expect(toolHardBudgetMs(selected)).toBe(12 * 60_000 + 2_500);
  });

  it("picks install task for npm install, not localStorage", () => {
    const pending = [
      { id: "t2", title: "Add Todo component and state logic" },
      { id: "t3", title: "Install project dependencies" },
      { id: "t4", title: "Persist tasks in localStorage" },
    ];
    const pick = pickPendingTaskForToolCall(pending, {
      name: "shell.exec",
      args: { command: "npm install" },
    });
    expect(pick?.id).toBe("t3");
  });

  it("injects install task into coding app plans", () => {
    const titles = ensureCodingPlanInstallTask(
      "coding",
      "Create a React Todo app",
      "Vite react todo",
      [
        "Create Vite React project",
        "Add Todo component",
        "Run dev server and verify",
      ],
    );
    expect(titles.some((t) => /install/i.test(t))).toBe(true);
    expect(titles[0]).toMatch(/Create Vite|Scaffold|project/i);
    expect(titles[1]).toMatch(/install/i);
  });

  it("injects feature task when feature app plan lacks implement step", () => {
    const titles = ensureCodingPlanFeatureTask(
      "coding",
      "Create a React Todo app",
      "Vite react todo on Desktop",
      [
        "Scaffold Vite project",
        "Install project dependencies",
        "Start dev server, probe localhost, leave running",
      ],
    );
    expect(titles.some((t) => /feature|implement|boilerplate/i.test(t))).toBe(
      true,
    );
  });

  it("normalizeCodingPlanTasks preserves authored task count and order", () => {
    const input = ["Scaffold Vite React project", "Run dev server and verify"];
    const titles = normalizeCodingPlanTasks(
      "coding",
      "Create a React Todo app",
      "todo feature",
      input,
    );
    expect(titles).toEqual(input);
    expect(titles).not.toBe(input);
  });
});

describe("typed task evidence", () => {
  it("classifies implement / install / verify titles", () => {
    expect(classifyTaskTitle("Implement todo feature")).toBe("implement");
    expect(classifyTaskTitle("Install project dependencies")).toBe("install");
    expect(
      classifyTaskTitle("Start dev server, probe localhost, leave running"),
    ).toBe("verify");
  });

  it("blocks implement done without feature write for feature apps", () => {
    let led = openTaskLedger("t2");
    led = recordTaskWorkSuccess(led, "t2", "fs.write", { sourceWrite: true });
    const gate = canMarkTaskDone(led, "t2", {
      taskTitle: "Implement the requested product feature",
      featureAppRequired: true,
      sessionFeatureSeen: false,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/feature/i);

    led = recordTaskWorkSuccess(led, "t2", "fs.write", { featureWrite: true });
    expect(
      canMarkTaskDone(led, "t2", {
        taskTitle: "Implement the requested product feature",
        featureAppRequired: true,
      }).ok,
    ).toBe(true);
  });

  it("blocks verify done without server/probe when title requires it", () => {
    let led = openTaskLedger("t4");
    led = recordTaskWorkSuccess(led, "t4", "fs.list");
    const gate = canMarkTaskDone(led, "t4", {
      taskTitle: "Start dev server, probe localhost, leave running",
    });
    expect(gate.ok).toBe(false);

    led = recordTaskWorkSuccess(led, "t4", "shell.start", {
      devServerStart: true,
    });
    expect(
      canMarkTaskDone(led, "t4", {
        taskTitle: "Start dev server, probe localhost, leave running",
      }).ok,
    ).toBe(true);
  });

  it("accepts port LISTEN or ready tail as local runtime proof", () => {
    let led = openTaskLedger("t7");
    led = recordTaskWorkSuccess(led, "t7", "shell.exec", {
      portListening: true,
    });
    expect(
      canMarkTaskDone(led, "t7", {
        taskTitle: "Leave server running for user to test",
      }).ok,
    ).toBe(true);

    let led2 = openTaskLedger("t7");
    led2 = recordTaskWorkSuccess(led2, "t7", "shell.tail", {
      serverReady: true,
    });
    expect(
      canMarkTaskDone(led2, "t7", {
        taskTitle: "Leave server running for user to test",
      }).ok,
    ).toBe(true);
  });

  it("inherits runtime for leave-running observation tasks (resume)", () => {
    expect(isRuntimeObservationTask("Leave server running for user to test")).toBe(
      true,
    );
    // No ledger required when plan already proved runtime
    expect(
      canMarkTaskDone(null, "t7", {
        taskTitle: "Leave server running for user to test",
        runtimeVerified: true,
      }).ok,
    ).toBe(true);
  });

  it("detects vite ready and lsof LISTEN outputs", () => {
    expect(
      isServerReadyOutput(
        "VITE v8.1.5  ready in 95 ms\n  ➜  Local:   http://localhost:5174/",
      ),
    ).toBe(true);
    expect(
      isPortListeningOutput(
        "lsof -i :5174",
        "node 98807 user 25u IPv6 0xabc 0t0 TCP localhost:5174 (LISTEN)",
      ),
    ).toBe(true);
    expect(hasLocalRuntimeProof({ sawPortListening: true })).toBe(true);
  });

  it("does not apply coding verify/implement gates on pentest titles", () => {
    expect(
      classifyTaskTitle("Probe HTTP endpoints on target", { planKind: "pentest" }),
    ).toBe("recon");
    expect(
      classifyTaskTitle("Start reverse shell listener, leave running", {
        planKind: "pentest",
      }),
    ).toBe("exploit");
    expect(
      classifyTaskTitle("Test API routes for IDOR", { planKind: "pentest" }),
    ).not.toBe("implement");

    let led = openTaskLedger("t2");
    led = recordTaskWorkSuccess(led, "t2", "dns.lookup", { remoteReconOk: true });
    expect(
      canMarkTaskDone(led, "t2", {
        taskTitle: "Probe HTTP endpoints on example.com",
        planKind: "pentest",
      }).ok,
    ).toBe(true);

    // Must not demand shell.start for pentest probe tasks
    let led2 = openTaskLedger("t2");
    led2 = recordTaskWorkSuccess(led2, "t2", "fs.list");
    const blocked = canMarkTaskDone(led2, "t2", {
      taskTitle: "Probe HTTP endpoints on example.com",
      planKind: "pentest",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/remote/i);
  });

  it("allows report observation when remote work already verified", () => {
    expect(isRemoteObservationTask("Write findings report")).toBe(true);
    expect(
      canMarkTaskDone(null, "t9", {
        taskTitle: "Document residual risk and findings",
        planKind: "pentest",
        remoteWorkVerified: true,
      }).ok,
    ).toBe(true);
  });

  it("blocks a pentest exploit task without active-test evidence", () => {
    const title = "Exploit SQL injection on /login to dump users";
    expect(classifyTaskTitle(title, { planKind: "pentest" })).toBe("exploit");

    let led = openTaskLedger("t5");
    led = recordTaskWorkSuccess(led, "t5", "http.fetch", {
      remoteReconOk: true,
    });
    const blocked = canMarkTaskDone(led, "t5", {
      taskTitle: title,
      planKind: "pentest",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/active-test/i);
  });

  it("allows a pentest exploit task once an active test succeeded", () => {
    let led = openTaskLedger("t5");
    led = recordTaskWorkSuccess(led, "t5", "shell.exec", {
      remoteActiveTestOk: true,
    });
    expect(
      canMarkTaskDone(led, "t5", {
        taskTitle: "Exploit SQL injection on /login to dump users",
        planKind: "pentest",
      }).ok,
    ).toBe(true);
  });

  it("does not block pentest recon or report tasks with the exploit rule", () => {
    let recon = openTaskLedger("t6");
    recon = recordTaskWorkSuccess(recon, "t6", "net.scan", {
      remoteReconOk: true,
    });
    expect(
      canMarkTaskDone(recon, "t6", {
        taskTitle: "Scan and enumerate services on target",
        planKind: "pentest",
      }).ok,
    ).toBe(true);

    expect(
      canMarkTaskDone(null, "t7", {
        taskTitle: "Write findings report and residual risk",
        planKind: "pentest",
        remoteWorkVerified: true,
      }).ok,
    ).toBe(true);
  });
});

describe("session state block", () => {
  it("builds compact working memory with next hint", () => {
    const block = buildSessionStateBlock({
      goal: "todo app",
      projectRoot: "/tmp/todo-app",
      featureAppRequired: true,
      featureSeen: false,
      pendingTasks: ["[t2] implement"],
    });
    expect(block.startsWith(SESSION_STATE_PREFIX)).toBe(true);
    expect(block).toContain("project_root:");
    expect(block).toMatch(/feature_needed=true/);
    expect(inferNextHint({ featureAppRequired: true, featureSeen: false })).toMatch(
      /feature/i,
    );
  });

  it("upserts SESSION STATE at the end so history prefix stays cacheable", () => {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "CONSTITUTION stable" },
      { role: "user", content: "scan the target" },
      { role: "assistant", content: "running recon" },
      { role: "tool", content: "open ports: 80, 443" },
    ];
    const blockA = buildSessionStateBlock({
      goal: "pentest",
      lastOkTool: "http.fetch",
      openTask: "[t1] recon",
    });
    upsertSessionStateMessage(messages, blockA);
    expect(messages).toHaveLength(5);
    expect(messages[0]!.content).toBe("CONSTITUTION stable");
    expect(messages[1]!.role).toBe("user");
    expect(messages[4]!.content).toContain("last_ok_tool: http.fetch");
    expect(
      messages.filter((m) => m.content.startsWith(SESSION_STATE_PREFIX)),
    ).toHaveLength(1);

    // Simulate another tool turn, then refresh state (last_ok_tool changes).
    messages.push(
      { role: "assistant", content: "next probe" },
      { role: "tool", content: "403 on /admin" },
    );
    const prefixBefore = messages
      .slice(0, 4)
      .map((m) => m.content)
      .join("\0");
    const blockB = buildSessionStateBlock({
      goal: "pentest",
      lastOkTool: "shell.exec",
      openTask: "[t2] auth",
    });
    upsertSessionStateMessage(messages, blockB);

    // Long history prefix must remain byte-identical (prompt-cache friendly).
    const prefixAfter = messages
      .slice(0, 4)
      .map((m) => m.content)
      .join("\0");
    expect(prefixAfter).toBe(prefixBefore);
    expect(
      messages.filter((m) => m.content.startsWith(SESSION_STATE_PREFIX)),
    ).toHaveLength(1);
    expect(messages[messages.length - 1]!.content).toContain(
      "last_ok_tool: shell.exec",
    );
    expect(messages[messages.length - 1]!.content).toContain("open_task:");
  });

  it("migrates a legacy early SESSION STATE insert to the trailing position", () => {
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "CONSTITUTION" },
      {
        role: "system",
        content: `${SESSION_STATE_PREFIX}\ngoal: old\nlast_ok_tool: web.search`,
      },
      { role: "user", content: "continue" },
      { role: "assistant", content: "ok" },
    ];
    upsertSessionStateMessage(
      messages,
      buildSessionStateBlock({ goal: "new", lastOkTool: "http.fetch" }),
    );
    expect(messages[0]!.content).toBe("CONSTITUTION");
    expect(messages[1]!.role).toBe("user");
    expect(messages[messages.length - 1]!.content).toContain(
      "last_ok_tool: http.fetch",
    );
    expect(
      messages.filter((m) => m.content.startsWith(SESSION_STATE_PREFIX)),
    ).toHaveLength(1);
  });
});

describe("tool.check local bin filter", () => {
  it("detects project-local node_modules bins", () => {
    expect(
      isProjectLocalNodeBin(
        "/Users/aniketpandey/Desktop/clai/node_modules/.bin/vite",
      ),
    ).toBe(true);
    expect(isProjectLocalNodeBin("/opt/homebrew/bin/node")).toBe(false);
  });
});

describe("feature implementation quality", () => {
  it("rejects Vite/Next starter boilerplate as feature code", () => {
    expect(
      looksLikeStarterBoilerplate(
        "export default function App() { return <h1>Welcome to Vite</h1> }",
      ),
    ).toBe(true);
    expect(
      isFeatureImplementationCall({
        name: "fs.write",
        args: {
          path: "src/App.tsx",
          content:
            "export default function App() {\n  return <h1>Welcome to Vite + React</h1>\n}\n",
        },
      }),
    ).toBe(false);
  });

  it("accepts real todo/product UI as feature code", () => {
    const content = `
import { useState } from 'react'
export default function App() {
  const [todos, setTodos] = useState([])
  function addTodo(t) { setTodos([...todos, { t, done: false }]) }
  function toggle(i) { setTodos(todos.map((x, n) => n===i ? {...x, done:!x.done} : x)) }
  return (<div>{todos.map((x,i)=><button onClick={()=>toggle(i)}>{x.t}</button>)}</div>)
}
`;
    expect(looksLikeFeatureProductCode(content)).toBe(true);
    expect(
      isFeatureImplementationCall({
        name: "fs.write",
        args: { path: "src/App.tsx", content },
      }),
    ).toBe(true);
  });
});
