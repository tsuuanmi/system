import { Context } from '@deepseek-ai/cordis'
import { FakeModels, modelsConformance } from '../conformance/models.ts'

// The seam's own fake passes the suite every provider must pass (INV-11).
modelsConformance('the fake provider', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(FakeModels)
  await fiber
  return { ctx, dispose: async () => void (await fiber.dispose()) }
})
