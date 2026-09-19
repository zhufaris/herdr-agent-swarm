import type { AgentKind } from "./agent-instance.js";
import type { BridgeCommand, InstanceCommand, ProjectConfig } from "./types.js";

export type NaturalLanguageTypedCommand =
  | { family: "swarm"; command: BridgeCommand }
  | { family: "instance"; command: InstanceCommand };

export type NaturalLanguageCommandResult =
  | ({ outcome: "command"; source: "deterministic" } & NaturalLanguageTypedCommand)
  | { outcome: "task" }
  | { outcome: "clarification"; message: string; examples: string[] }
  | { outcome: "unsupported"; message: string; examples: string[] };

export interface NaturalLanguageCommandInterpreter { interpret(text: string): NaturalLanguageCommandResult }

const AGENT_KINDS = new Set<AgentKind>(["traex", "pi", "codex", "claude-code"]);
const COMMAND_LEADS = /^(?:请|帮我|麻烦)?(?:查看|显示|列出|打开|切换|选择|创建|新建|重置|重新连接|连接|替换|恢复|唤醒|跳过|停止|终止|中断|修改|重命名|关闭|发送|告诉|追加|补充|转向|steer(?:\s|$)|show(?:\s|$)|list(?:\s|$)|open(?:\s|$)|switch(?:\s|$)|select(?:\s|$)|create(?:\s|$)|new(?:\s|$)|reset(?:\s|$)|reattach(?:\s|$)|attach(?:\s|$)|replace(?:\s|$)|resume(?:\s|$)|awake(?:\s|$)|skip(?:\s|$)|stop(?:\s|$)|interrupt(?:\s|$)|rename(?:\s|$)|close(?:\s|$)|send(?:\s|$))/i;
const TASK_LEADS = /^(?:请|帮我|麻烦)?(?:实现|修复|排查|分析|优化|编写|更新|重构|测试|review(?:\s|$)|implement(?:\s|$)|fix(?:\s|$)|debug(?:\s|$)|investigate(?:\s|$)|analy[sz]e(?:\s|$)|optimi[sz]e(?:\s|$)|write(?:\s|$)|update(?:\s|$)|refactor(?:\s|$)|test(?:\s|$))/i;

export class DeterministicNaturalLanguageCommandInterpreter implements NaturalLanguageCommandInterpreter {
  constructor(private readonly projects: readonly ProjectConfig[]) {}

  interpret(rawText: string): NaturalLanguageCommandResult {
    const text = normalize(rawText);
    if (!text) return { outcome: "task" };
    if (/^(?:(?:创建|新建)(?:一个)?(?:新)?(?:项目|workspace|space)|(?:create|add)\s+(?:(?:a|one)\s+)?(?:new\s+)?(?:project|workspace|space))(?:\s|$)/i.test(text)) {
      return unsupported("飞书自然语言不能新增项目或 Herdr Workspace；项目来自受控的 projects.json。你可以查看已配置项目，或在项目中创建新的 Primary 任务/会话。", ["查看项目", "在 <项目> 创建新任务：<标题>"]);
    }

    const exact = this.exactQuery(text);
    if (exact) return command(exact);
    if (/^(?:停一下|停止|stop|换个模型|切换模型|创建\s*worker|新建\s*worker|创建任务|新建任务)$/i.test(text)) return clarify("这条控制指令缺少必要的目标或参数，不会执行。", ["停止当前任务", "切换模型 <model>", "创建 worker <name>"]);

    const project = /^(?:(?:切换|选择|打开)(?:到)?项目|(?:switch(?:\s+to)?|select|open)\s+project)\s+(.+)$/i.exec(text);
    if (project) {
      const projectId = this.projectId(project[1]!);
      return projectId ? instance({ kind: "project", projectId }) : clarify("没有找到这个已配置项目。", ["查看项目", "选择项目 <project-id>"]);
    }

    const primary = /^(?:在\s+(.+?)\s+)?(?:(?:创建|新建)(?:一个)?(?:新)?(?:primary)?(?:任务|会话)|(?:create|start)\s+(?:(?:a|one)\s+)?(?:new\s+)?(?:primary\s+)?(?:task|session))(?:\s*[:：-]\s*|\s+)?(.*)$/i.exec(text);
    if (primary) {
      if (primary[1] && !this.projectId(primary[1])) return clarify("没有找到目标项目。", ["查看项目", "在 <project-id> 创建新任务：<标题>"]);
      return swarm({ kind: "new", title: primary[2]?.trim() || null, agentKind: "traex" });
    }

    const workerCreate = /^(?:(?:创建|新建)\s*(?:一个)?\s*(?:worker\s+)?|(?:create|add)\s+(?:(?:a|one)\s+)?(?:worker\s+)?)([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\s+(?:worker|工作者))?(.*)$/i.exec(text);
    if (workerCreate) {
      const tail = workerCreate[2]!.trim();
      let agentKind: AgentKind = "traex";
      const agent = /(?:使用|agent|with)\s+(traex|pi|codex|claude-code)(?:\s|$)/i.exec(tail);
      if (agent && AGENT_KINDS.has(agent[1]!.toLowerCase() as AgentKind)) agentKind = agent[1]!.toLowerCase() as AgentKind;
      const model = /(?:模型|model)\s+([A-Za-z0-9][A-Za-z0-9._:+/-]{0,127})/i.exec(tail)?.[1] ?? null;
      const start = /(?:并启动|立即启动|启动|and\s+start(?:\s|$)|--start(?:\s|$))/i.test(tail);
      return swarm({ kind: "worker_create", name: workerCreate[1]!, agentKind, model, start });
    }

    const workerMessage = /^(?:(?:发送|告诉)\s*(?:给)?\s*|(?:send|message)\s+(?:to\s+)?)(?:worker\s+)?([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*[:：]\s*(.+)$/i.exec(text);
    if (workerMessage) return instance({ kind: "to", name: workerMessage[1]!, text: workerMessage[2]!.trim() });
    const workerSteer = /^(?:steer|追加|补充|转向)\s+(?:worker\s+)?([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*[:：]\s*(.+)$/i.exec(text);
    if (workerSteer) return instance({ kind: "steer_instance", name: workerSteer[1]!, text: workerSteer[2]!.trim() });
    const workerStop = /^(?:停止|终止|中断|stop|interrupt)\s+(?:worker\s+)?([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/i.exec(text);
    if (workerStop && !/^(?:当前|current)$/i.test(workerStop[1]!)) return instance({ kind: "stop_instance", name: workerStop[1]! });
    const workerOpen = /^(?:查看|打开|show|open)\s+(?:worker|实例|instance)\s+([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/i.exec(text);
    if (workerOpen) return instance({ kind: "instance", name: workerOpen[1]! });

    const rename = /^(?:重命名|修改标题|rename)(?:\s+(?:为|to))?\s+(.+)$/i.exec(text);
    if (rename) return swarm({ kind: "rename", title: rename[1]!.trim() });
    const reset = /^(?:重置|reset)(?:\s*(?:会话|session))?(?:\s*[:：-]\s*|\s+)?(.*)$/i.exec(text);
    if (reset) return swarm({ kind: "reset", title: reset[1]?.trim() || null });
    const model = /^(?:(?:切换|选择|使用)模型|(?:switch(?:\s+to)?|select|use)\s+model)\s+([A-Za-z0-9][A-Za-z0-9._:+/-]{0,127})$/i.exec(text);
    if (model) return swarm({ kind: "model", name: model[1]! });
    const attach = /^(?:连接|attach)\s+(?:pane\s+)?(\S+)\s+(\S+)$/i.exec(text);
    if (attach) return swarm({ kind: "attach", spaceName: attach[1]!, paneId: attach[2]! });
    const reattach = /^(?:重新连接|reattach)\s+(?:pane\s+)?(\S+)$/i.exec(text);
    if (reattach) return swarm({ kind: "reattach", paneId: reattach[1]! });
    const closeConfirm = /^(?:确认关闭|confirm\s+close)(?:\s+pane)?\s+([A-Za-z0-9]+)$/i.exec(text);
    if (closeConfirm) return swarm({ kind: "pane_close_confirm", code: closeConfirm[1]! });
    const steer = /^(?:steer|追加|补充|调整方向)(?:\s*(?:当前任务|current task))?\s*[:：]\s*(.+)$/i.exec(text);
    if (steer) return swarm({ kind: "steer", text: steer[1]!.trim() });

    if (/^(?:(?:停止|终止|中断)(?:当前任务|当前turn)|(?:stop|interrupt)\s+(?:current task|current turn))$/i.test(text)) return swarm({ kind: "stop" });
    if (/^(?:(?:关闭)\s*(?:当前)?\s*(?:pane|面板|会话)|close(?:\s+current)?\s+(?:pane|session))$/i.test(text)) return swarm({ kind: "pane_close_request" });
    if (/^(?:替换|replace)(?:\s*(?:pane|会话|session))?$/i.test(text)) return swarm({ kind: "replace" });
    if (/^(?:恢复|resume)(?:\s*(?:会话|session))?$/i.test(text)) return swarm({ kind: "resume" });
    if (/^(?:唤醒|awake)(?:\s*(?:会话|session))?$/i.test(text)) return swarm({ kind: "awake" });
    if (/^(?:跳过|skip)(?:\s*(?:detached\s*)?(?:任务|prompt))?$/i.test(text)) return swarm({ kind: "skip" });

    if (TASK_LEADS.test(text)) return { outcome: "task" };
    if (COMMAND_LEADS.test(text)) return clarify("无法唯一确定要执行的 Swarm 指令，不会作为 Agent 任务发送。", ["查看帮助", "查看状态", "创建新任务：<标题>"]);
    return { outcome: "task" };
  }

  private exactQuery(text: string): NaturalLanguageTypedCommand | null {
    if (/^(?:帮助|查看帮助|help|commands?)$/i.test(text)) return typedSwarm({ kind: "help" });
    if (/^(?:(?:查看|显示|列出)\s*(?:所有)?\s*(?:已配置)?\s*项目|(?:show|list)?\s*projects?)$/i.test(text)) return typedSwarm({ kind: "projects" });
    if (/^(?:(?:查看|显示|列出)\s*(?:所有)?\s*(?:space|空间)|(?:show|list)?\s*spaces?)$/i.test(text)) return typedSwarm({ kind: "spaces" });
    if (/^(?:(?:查看|显示|列出)\s*(?:所有)?\s*(?:pane|面板)|(?:show|list)?\s*panes?)$/i.test(text)) return typedSwarm({ kind: "panes" });
    if (/^(?:(?:查看|显示|列出)\s*(?:所有)?\s*会话|(?:show|list)?\s*sessions?)$/i.test(text)) return typedSwarm({ kind: "sessions", cursor: null });
    if (/^(?:(?:查看|显示|列出)\s*(?:所有)?\s*(?:失败|故障)|(?:show|list)?\s*failures?)$/i.test(text)) return typedSwarm({ kind: "failures" });
    if (/^(?:(?:查看|显示)?(?:当前)?状态(?:怎么样|如何)?|(?:show\s+)?status|当前状态怎么样|现在怎么样)$/i.test(text)) return typedSwarm({ kind: "status" });
    if (/^(?:(?:查看|显示)(?:当前)?模型|(?:show\s+)?model)$/i.test(text)) return typedSwarm({ kind: "model", name: null });
    if (/^(?:(?:查看|显示|列出)\s*(?:所有)?\s*(?:workers?|实例|工作者)|(?:show|list)?\s*(?:workers?|instances?))$/i.test(text)) return typedInstance({ kind: "instances" });
    return null;
  }

  private projectId(value: string): string | null {
    const normalized = value.trim().toLowerCase();
    const matches = this.projects.filter((project) => project.id.toLowerCase() === normalized || project.displayName.toLowerCase() === normalized || project.spaceName?.toLowerCase() === normalized);
    return matches.length === 1 ? matches[0]!.id : null;
  }
}

function normalize(value: string): string { return value.trim().replace(/^[,，:：\s]+/, "").replace(/[。！？!?]+$/, "").trim(); }
function command(value: NaturalLanguageTypedCommand): NaturalLanguageCommandResult { return { outcome: "command", source: "deterministic", ...value }; }
function typedSwarm(command: BridgeCommand): NaturalLanguageTypedCommand { return { family: "swarm", command }; }
function typedInstance(command: InstanceCommand): NaturalLanguageTypedCommand { return { family: "instance", command }; }
function swarm(value: BridgeCommand): NaturalLanguageCommandResult { return command(typedSwarm(value)); }
function instance(value: InstanceCommand): NaturalLanguageCommandResult { return command(typedInstance(value)); }
function clarify(message: string, examples: string[]): NaturalLanguageCommandResult { return { outcome: "clarification", message, examples }; }
function unsupported(message: string, examples: string[]): NaturalLanguageCommandResult { return { outcome: "unsupported", message, examples }; }
