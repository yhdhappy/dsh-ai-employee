/**
 * 3 个 memory Tool 定义（V0.3 §21 + V0.2 B）。
 *
 *   workspace.write_memory({ fileName, content })
 *   workspace.read_memory({ fileName })
 *   workspace.list_memory()
 *
 * 名字以 "workspace." 前缀对齐 V0.2 B.4 / B.5 的命名约定。
 *
 * 这些 Tool 由 host 半边在 plugin 装配完成后通过 `harness.registerTool()` 注册；
 * 浏览器（client 半边）通过 `__DSH_BOOT__` 自然看到它们，模型可以直接调用。
 *
 * Actor：默认 'bot'（这是 Bot 调用）；botId 暂时用 exec.agent?.id 占位（实际身份
 * 解析在 segment 2 编排阶段细化）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { MemoryService } from './memory-service.js'

interface ArgsWrite {
  workspaceId: string
  fileName: string
  content: string
}
interface ArgsRead {
  workspaceId: string
  fileName: string
}
interface ArgsList {
  workspaceId: string
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

export interface MemoryToolsDeps {
  memory: MemoryService
}

/** 构造 3 个 Tool 定义（不注册；由调用方 decide 注册时机）。 */
export function createMemoryToolDefinitions(deps: MemoryToolsDeps): ToolDefinition[] {
  const { memory } = deps

  const writeTool = defineTool({
    name: 'workspace_write_memory',
    description:
      '把一段 Markdown 内容写到指定项目记忆文件（位于 <workspaceRoot>/docs/）。' +
      'fileName 必须是 .md 后缀，不允许 .. 越界。返回写入的 fileName、绝对路径和字节数。',
    parameters: {
      workspaceId: { type: 'string', required: true, description: '项目 ID' },
      fileName: {
        type: 'string',
        required: true,
        description: '相对 docs/ 的 Markdown 文件名，例如 "product.md" 或 "design/api.md"',
      },
      content: { type: 'string', required: true, description: 'Markdown 内容' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileName: { type: 'string' },
          path: { type: 'string' },
          bytes: { type: 'number' },
        },
      },
      render: (_args, value) => textBlock(JSON.stringify(value, null, 2)),
    },
    async execute(args: ArgsWrite) {
      return await memory.writeMemory({
        workspaceId: args.workspaceId,
        fileName: args.fileName,
        content: args.content,
        actor: 'bot',
      })
    },
  })

  const readTool = defineTool({
    name: 'workspace_read_memory',
    description: '读指定项目记忆文件的 Markdown 内容。返回 fileName、绝对路径、content。',
    parameters: {
      workspaceId: { type: 'string', required: true, description: '项目 ID' },
      fileName: { type: 'string', required: true, description: '相对 docs/ 的文件名' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fileName: { type: 'string' },
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock(value.content ?? ''),
    },
    async execute(args: ArgsRead) {
      const result = await memory.readMemory({
        workspaceId: args.workspaceId,
        fileName: args.fileName,
        actor: 'bot',
      })
      // 把 content 字段从 ReadResult 里搬出来作为模型看到的输出
      return {
        fileName: result.fileName,
        path: result.path,
        content: result.content,
      }
    },
  })

  const listTool = defineTool({
    name: 'workspace_list_memory',
    description: '列出指定项目记忆目录下所有 Markdown 文件（含子目录）。返回文件名 + 路径 + 字节数。',
    parameters: {
      workspaceId: { type: 'string', required: true, description: '项目 ID' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fileName: { type: 'string' },
                path: { type: 'string' },
                bytes: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const files = value.files ?? []
        const list = files.map((f) => `- ${f.fileName}  (${f.bytes} bytes)`).join('\n')
        return textBlock(list || '（空）')
      },
    },
    async execute(args: ArgsList) {
      const result = await memory.listMemory({
        workspaceId: args.workspaceId,
        actor: 'bot',
      })
      return { files: result.files }
    },
  })

  return [writeTool, readTool, listTool]
}