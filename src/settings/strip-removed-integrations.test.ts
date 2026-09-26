import { expect, it } from 'vitest'
import { stripRemovedIntegrations } from './strip-removed-integrations'

it('removes Nutstore credentials and gateway without mutating custom providers', () => {
	const original = {
		account: 'old',
		credential: 'old-secret',
		oauthResponseText: 'old-ticket',
		ai: {
			nutstoreLlmGateway: { token: 'old-token' },
			providers: {
				'nutstore-llm-gateway': { apiKey: 'old' },
				custom: { apiKey: 'keep' },
			},
		},
	}
	expect(stripRemovedIntegrations(original)).toEqual({
		ai: { providers: { custom: { apiKey: 'keep' } } },
	})
	expect(original.ai.providers['nutstore-llm-gateway']).toBeDefined()
})
