import { z } from 'zod';
import { providerPermissionModeSchema } from './provider-command.js';
import { sessionProviderSchema } from './sessions.js';

const allowedTemplatePlaceholders = new Set([
  'executable',
  'cwd',
  'promptFile',
  'providerSessionId',
  'title',
]);

const providerCommandTemplateSchema = z.string().trim().min(1).max(4_000).superRefine((template, context) => {
  if (template.includes('\0')) {
    context.addIssue({ code: 'custom', message: '命令模板不能包含 NUL 控制字符' });
  }
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const placeholder = match[1] ?? '';
    if (!allowedTemplatePlaceholders.has(placeholder)) {
      context.addIssue({ code: 'custom', message: `命令模板包含未知占位符：${placeholder}` });
    }
  }
  if (!/\{\{\s*executable\s*\}\}/.test(template)) {
    context.addIssue({ code: 'custom', message: '命令模板必须包含 {{executable}}' });
  }
  if (/(?:ANTHROPIC|OPENAI|DEEPSEEK)_API_KEY|\bsk-[A-Za-z0-9_-]{16,}/i.test(template)) {
    context.addIssue({ code: 'custom', message: '命令模板不能写入 API Key 或疑似访问令牌' });
  }
});

export const cmuxConfigSchema = z.object({
  version: z.literal(1),
  providerTemplates: z.object({
    claude: providerCommandTemplateSchema,
    codex: providerCommandTemplateSchema,
  }).strict(),
}).strict();
export type CmuxConfig = z.infer<typeof cmuxConfigSchema>;

export const cmuxCapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  state: z.enum(['available', 'unavailable', 'unknown']),
  command: z.string().min(1).max(255),
  executablePath: z.string().min(1).max(4_000).nullable(),
  version: z.string().max(1_000).nullable(),
  detectedAt: z.string().datetime({ offset: true }),
  message: z.string().min(1).max(2_000),
}).strict();
export type CmuxCapability = z.infer<typeof cmuxCapabilitySchema>;

export const cmuxSettingsStatusSchema = z.object({
  schemaVersion: z.literal(1),
  config: cmuxConfigSchema,
  capability: cmuxCapabilitySchema,
}).strict();
export type CmuxSettingsStatus = z.infer<typeof cmuxSettingsStatusSchema>;

export const recoveryLaunchSchema = z.object({
  schemaVersion: z.literal(1),
  provider: sessionProviderSchema,
  permissionMode: providerPermissionModeSchema,
  permissionFlag: z.string().min(1).max(255).nullable(),
  cwd: z.string().min(1).max(4_000),
  promptFile: z.string().min(1).max(4_000),
  shellCommand: z.string().min(1).max(120_000),
  shellExecutable: z.string().min(1).max(4_000),
  shellExecutableSource: z.enum(['real-binary', 'command-name']),
  cmuxCommand: z.string().min(1).max(120_000),
  cmuxCliCommand: z.string().min(1).max(120_000),
  workspaceName: z.string().min(1).max(160),
  cmux: cmuxCapabilitySchema,
  canOpenInCmux: z.boolean(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  message: z.string().min(1).max(2_000),
}).strict();
export type RecoveryLaunch = z.infer<typeof recoveryLaunchSchema>;

export const cmuxOpenRequestSchema = z.object({
  localPath: z.string().trim().min(1).max(4_000).nullable().optional(),
  checkpointId: z.string().trim().min(1).max(255).optional(),
  permissionMode: providerPermissionModeSchema.default('standard'),
  expectedLaunchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  confirmOpenInCmux: z.literal(true),
}).strict();
export type CmuxOpenRequest = z.input<typeof cmuxOpenRequestSchema>;

export const cmuxOpenResultSchema = z.object({
  schemaVersion: z.literal(1),
  opened: z.literal(true),
  workspaceName: z.string().min(1).max(160),
  message: z.string().min(1).max(1_000),
}).strict();
export type CmuxOpenResult = z.infer<typeof cmuxOpenResultSchema>;
