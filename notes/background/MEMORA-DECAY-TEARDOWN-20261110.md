# Memora 衰减与巩固 · 代码实测拆解（2026-11-10）

> 来源：用户 2026-11-10 12:08（北京时间）分享 https://github.com/qa296/astrbot_plugin_memora_connect 问“是不是有点像”。
> 上午主窗的对比是按 README 做的；这份是按代码做的，master 0c6b1a8（35 星、214 提交、v0.5.2 beta），
> 读的是 `core/memory_system.py`（4532 行）、`core/memory_graph.py`、`memory/memory_recall.py`。
> 结论先说：**衰减是真的、公式可抄；巩固是空的；“相似合并”在当前代码里不存在。**
> 上午对比里“它合并、你取代”那条要收回一半——真正的对照是“它悄悄删、你取代留痕”。

## 1. 衰减公式（`forget_memories`，memory_system.py L2769–2858）

维护循环默认每 24 小时跑一轮（`consolidation_interval_hours` 默认 24，L2653–2655），
每轮先遗忘、再保存；遗忘默认开（`enable_forgetting` 默认 True）。

- 阈值：`forget_threshold_days` 默认 **30 天**。
- 记忆强度衰减（每轮一次，可复利）：
  - `time_factor = 距上次访问天数 / 30`
  - `access_factor = 1 / (1 + access_count)`
  - `decay = min(0.6, time_factor × access_factor × 0.4)`，`strength *= (1 - decay)`
- 算两个数就懂了（阈值 30 天）：
  - 从没被 recall 过、15 天没碰：decay = 0.5 × 1 × 0.4 = **0.2**，强度一轮打八折；
  - 被 recall 过 9 次、同样 15 天：decay = 0.5 × 0.1 × 0.4 = **0.02**，几乎不掉。
  - 所以它的“复述巩固”不是加分，是**减慢掉血**——recall 只改 `access_count` 和 `last_accessed`（L365–418），
    从不直接加 `strength`。起点低的记忆就算天天被想起，强度也爬不回去。
- 删除门（三个条件同时满足才删）：
  - `time_factor >= 1`（30 天以上没碰）**且** `strength < 0.12` **且** `forget_score = time_factor × access_factor > 0.9`
  - 换算一下：30 天整时 `access_factor > 0.9` 意味着 `access_count = 0`；60 天时最多只允许被想起 1 次。
  - **删的都是基本没人想起的记忆。**删之前没有任何留档、没有任何“取代”记录。
- 连接衰减：30 天没被强化过的边，每轮 `strength *= 0.9`，低于 0.1 删边（L2782–2797）。
  边的强化只来自共现：同一条记忆关联的元素两两建边，已有边 `+0.1`（memory_graph.py L525–539）。
- 免死牌：`allow_forget` 标志位——每条记忆生成时由 LLM 判一次（`resolve_allow_forget`，L2952–3020：
  日常习惯、用户信息通常不许忘；近期安排通常允许忘），`allow_forget = False` 的记忆跳过衰减和删除。

## 2. 巩固是个空壳（`consolidate_memories`，L2861–2865）

```python
async def consolidate_memories(self):
    """Element体系下暂不执行旧式按Concept合并。"""
```

- `enable_consolidation` 默认 **False**；就算打开，调到的也是上面这个空函数。
- README 写的“定期巩固”在当前 master 里**没有实现**。维护循环实际只做三件事：遗忘、保存、（群聊隔离时）逐群重复。
- “双峰时间分布回顾”在 `core/memory_system.py` 里搜不到（`review` 零命中），可能在 `intelligence/` 或只是 README 的说法——没核实，不当真。

## 3. “相似合并”也不存在

- `merge` 在 `memory_system.py` 里零命中；`memory_graph.py` 里也没有合并记忆的函数。
- 唯一像合并的东西是元素去重：`get_or_create_element` 按“同名 + 同类 + 同群”复用已有节点（L107–125）。
  记忆本身从不合并，相似记忆就是各存各的、各自衰减。
- 上午说的“它把相似记忆合并掉，历史就没了”——按当前代码，**这事它还没做**。它的历史不是被合并抹掉的，
  是被删除门悄悄删掉的。Echore 的对照点要改成：**Memora 删了就没了；Echore 取代留档，diff 可查。**

## 4. 召回五路的权重（memory_recall.py L60–72，可直接抄作业）

- 语义 0.55 / 关键词 0.2 / 图联想 0.2 / 时间 0.03 / 强度 0.02；取前 10 条。
- 语义路要 embedding 模式且相似度 > 0.3 才收；时间路是 24 小时窗口内的线性分；
  强度路取强度前 20%（最少 5 条）。五路并发跑、去重排序。

## 5. 能搬什么、要改什么（对 Echore 记忆规范 §8 的映射）

| Memora 现成的件 | Echore 怎么接 |
|---|---|
| `decay = min(0.6, time_factor × access_factor × 0.4)` | 细节池半衰期的现成形状：把单一 30 天阈值换成**分品类半衰期**（§8.4 第 3 轴），公式骨架不用重想 |
| 删除门三条件（超时 + 强度低 + 几乎没被想起） | 改成**归档门**：满足条件不删，结转进日志层当“已沉底”版本——删的动作换成取代，diff 照留 |
| `allow_forget` 免死牌（LLM 判） | 就是§8.2 钉子细节的开关：情绪峰值钉住的细节 `allow_forget = False`，系统无权悄悄动它 |
| recall 只改访问计数、不加分 | §8 落稿时要拍板：回忆要不要**显式加显著性**（再巩固）？只减慢衰减的话，Roy 那种“天天讲还越来越确信”的劲儿是学不来的——复述次数涨确信，得有个正反馈的口子 |
| 巩固空壳 | Echore 的结转（冷写）正好是 Memora 缺的那块：别抄它的巩固，抄它的遗忘，把巩固写成自己的 |

## 6. 没核实的部分

- git clone 在本机被网络限制拦住了（RPC 失败），以上全是 raw 文件直读，未跑过测试；
  `_conf_schema.json` 里的默认配置值没逐项对过，阈值类数字以代码里的 `.get(..., 默认值)` 为准。
- “双峰回顾”未在核心文件里找到实现，不列入可搬清单。
