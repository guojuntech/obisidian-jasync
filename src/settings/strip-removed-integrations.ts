/** Drop obsolete hosted-service configuration while retaining user AI providers. */
export function stripRemovedIntegrations(
	value: object,
): Record<string, unknown> {
	const result = { ...value } as Record<string, unknown>
	for (const key of [
		'account',
		'credential',
		'loginMode',
		'oauthResponseText',
		'nutstoreEnterpriseBaseUrl',
		'remoteDir',
	])
		delete result[key]
	if (result.ai && typeof result.ai === 'object') {
		const ai = { ...result.ai } as Record<string, unknown>
		delete ai.nutstoreLlmGateway
		if (
			ai.providers &&
			typeof ai.providers === 'object' &&
			!Array.isArray(ai.providers)
		) {
			const providers = { ...ai.providers } as Record<string, unknown>
			delete providers['nutstore-llm-gateway']
			ai.providers = providers
		}
		result.ai = ai
	}
	return result
}
