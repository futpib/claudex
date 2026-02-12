import { z } from 'zod';

export const notifyMessageSchema = z.object({
	type: z.literal('notify'),
	summary: z.string(),
	body: z.string().optional(),
	urgency: z.enum([ 'low', 'normal', 'critical' ]).optional(),
});

export type NotifyMessage = z.infer<typeof notifyMessageSchema>;

export const journalMessageSchema = z.object({
	type: z.literal('journal'),
	tag: z.string(),
	priority: z.enum([ 'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug' ]).optional(),
	message: z.string(),
});

export type JournalMessage = z.infer<typeof journalMessageSchema>;

export const hostMessageSchema = z.union([
	notifyMessageSchema,
	journalMessageSchema,
	z.object({ type: z.string() }).loose(),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
