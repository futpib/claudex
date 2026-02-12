import { z } from 'zod';

export const notifyMessageSchema = z.object({
	type: z.literal('notify'),
	summary: z.string(),
	body: z.string().optional(),
	urgency: z.enum([ 'low', 'normal', 'critical' ]).optional(),
});

export type NotifyMessage = z.infer<typeof notifyMessageSchema>;

export const hostMessageSchema = z.union([
	notifyMessageSchema,
	z.object({ type: z.string() }).loose(),
]);

export type HostMessage = z.infer<typeof hostMessageSchema>;
