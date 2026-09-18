# 资产库导入性能测试计划

本文档旨在指导如何评估和测试资产库导入功能的性能，识别瓶颈并验证优化效果。

## 1. 测试目标

*   **基准建立**：确定当前系统在不同负载下的标准处理速度（资产/秒）。
*   **瓶颈识别**：确定性能瓶颈是位于磁盘 I/O、CPU（二进制解析）、数据库写入还是内存占用。
*   **极限测试**：确定系统能稳定处理的最大资产数量和文件大小。

## 2. 测试工具

我们提供了一个脚本用于生成测试数据：`tests/performance/generate_test_assets.js`。
以及一个核心性能基准测试工具：`tests/performance/benchmark_parser.ts`。

### 使用方法

运行生成脚本：
```bash
# 查看帮助
node tests/performance/generate_test_assets.js --help

# 示例：生成 1000 个小文件
node tests/performance/generate_test_assets.js --output ./temp/test_data_1k --count 1000 --size 10 --unique
```

运行解析器基准测试（需修改脚本中的目标路径）：
```bash
npx ts-node tests/performance/benchmark_parser.ts
```

## 3. 测试场景 (Test Scenarios)

### 场景 A：基准测试 (Baseline)
*   **描述**：少量标准大小文件，用于确认功能正常及建立基准延迟。
*   **数据**：100 个文件，每个 10KB，平铺结构。
*   **命令**：
    ```bash
    node tests/performance/generate_test_assets.js --output ./temp/scenario_a --count 100 --size 10 --unique
    ```

### 场景 B：海量小文件 (Volume Stress)
*   **描述**：测试数据库写入吞吐量和文件系统遍历性能。
*   **数据**：10,000 个文件，每个 1KB，平铺结构。
*   **命令**：
    ```bash
    node tests/performance/generate_test_assets.js --output ./temp/scenario_b --count 10000 --size 1 --unique
    ```
*   **关注点**：数据库事务处理速度、UI 响应度。

### 场景 C：深层目录结构 (Deep Nesting)
*   **描述**：测试递归扫描算法和路径解析逻辑。
*   **数据**：5,000 个文件，深度 10 层，每层 5 个子文件夹。
*   **命令**：
    ```bash
    node tests/performance/generate_test_assets.js --output ./temp/scenario_c --count 5000 --depth 10 --folders 5
    ```
*   **关注点**：扫描阶段的耗时。

### 场景 D：大文件处理 (Large File IO)
*   **描述**：测试大文件哈希计算和内存占用。
*   **数据**：50 个文件，每个 100MB（注意磁盘空间）。
*   **命令**：
    ```bash
    node tests/performance/generate_test_assets.js --output ./temp/scenario_d --count 50 --size 102400
    ```
*   **关注点**：内存峰值、是否有 OOM (Out of Memory) 崩溃、哈希计算耗时。

### 场景 E：真实数据模拟 (Real World)
*   **描述**：使用真实的 `.uasset` 文件副本，测试解析器性能。
*   **数据**：提供一个真实的 `source.uasset`，复制 1,000 次。
*   **命令**：
    ```bash
    node tests/performance/generate_test_assets.js --output ./temp/scenario_e --count 1000 --source /path/to/real/Content/Hero.uasset --unique
    ```
*   **关注点**：`UnrealAssetProcessor` 解析耗时。

## 4. 执行步骤

1.  **准备数据**：根据上述场景生成测试数据。
2.  **启动应用**：以开发模式启动应用，打开 DevTools (Ctrl+Shift+I)。
    ```bash
    pnpm dev
    ```
3.  **开始监控**：
    *   在 DevTools -> Performance 标签页，点击录制（Record）。
    *   或者关注 Console 中的 `[AssetImportService]` 日志。
4.  **执行导入**：
    *   在应用中选择“导入文件夹”。
    *   选择生成的测试数据目录。
5.  **记录数据**：
    *   记录开始时间（点击导入瞬间）和结束时间（进度条 100%）。
    *   观察 Console 中是否有错误或警告。
    *   查看 Task Manager (任务管理器) 中的 CPU 和内存占用。
6.  **清理**：
    *   测试完成后，建议清空数据库或删除测试生成的文件夹，以免影响正常开发。

## 5. 性能指标 (Metrics)

| 指标 | 说明 | 目标值 (参考) |
| :--- | :--- | :--- |
| **Throughput** | 每秒处理资产数 (Assets/sec) | > 50 ops |
| **Scan Time** | 扫描文件结构所需时间 | < 1s / 10k files |
| **Parse Time** | 单个文件解析平均耗时 | < 50ms |
| **DB Write Time** | 数据库写入平均耗时 | < 10ms |
| **Peak Memory** | 峰值内存占用 | < 1GB |

## 6. 真实数据压力测试报告 (2025-12-28)

### 测试环境
*   **OS**: Windows
*   **Data Source**: `H:\TEST ASSET\Iceland`
*   **File Count**: 213 .uasset files
*   **Total Size**: 6.2 GB
*   **Tool**: `tests/performance/benchmark_parser.ts` (模拟核心导入逻辑)

### 测试结果
*   **总耗时 (Wall Clock)**: 4.33 秒
*   **数据吞吐量**: 1.46 GB/s
*   **解析吞吐量**: ~49 个文件/秒 (受限于大文件 IO)
*   **平均单文件耗时**: 20.3 ms (含 IO)
*   **解析耗时 (CPU)**: 1.62 秒 (仅占总时间的 37%)
*   **MD5 计算耗时**: 0.10 秒 (使用采样算法)
*   **内存峰值**: 169 MB

### 结论
当前资产解析和哈希计算逻辑性能极佳，能够轻松应对大规模真实资产导入。
瓶颈主要在于磁盘读取速度（IO Bound），但即便如此，处理 6GB 数据仅需 4.33 秒，性能远超一般用户需求。
内存占用控制在 200MB 以内，非常稳定。
