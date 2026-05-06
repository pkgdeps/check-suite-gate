import * as core from '@actions/core'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './server.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  core.summary.emptyBuffer()
})
afterAll(() => server.close())
