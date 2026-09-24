import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

const quotasSource = readSource('../src/routes/quotas/+page.svelte')
const i18nSource = readSource('../src/lib/i18n.js')

describe('quotas inactive section', () => {
  it('gives tools that merely lack credentials their own header string', () => {
    expect(quotasSource).toContain('quotas.inactiveTitle')
    // The generic no-data string stays only for the truly empty quotas response.
    const inactiveBlock = quotasSource.slice(quotasSource.indexOf('Inactive tools'))
    expect(inactiveBlock).not.toContain("common.noData'")
    expect(inactiveBlock).toContain("quotas.inactiveTitle")
  })

  it('surfaces the probe reason on the inactive card when present', () => {
    expect(quotasSource).toContain('quota.credentialMessage')
  })

  it('covers the inactive header in both languages', () => {
    expect(i18nSource).toContain("inactiveTitle: 'Not connected'")
    expect(i18nSource).toContain("inactiveTitle: '未连接'")
  })
})

describe('tool-filtered idle hint', () => {
  const pages = [
    '../src/routes/overview/+page.svelte',
    '../src/routes/tokens/+page.svelte',
    '../src/routes/cost/+page.svelte',
    '../src/routes/models/+page.svelte',
    '../src/routes/projects/+page.svelte',
    '../src/routes/sessions/+page.svelte',
    '../src/routes/tool-calls/+page.svelte',
  ]

  it('covers the idle hint in both languages with a tool placeholder', () => {
    expect(i18nSource).toContain('toolIdleHint')
    expect(i18nSource).toContain('No activity for {tool} in this period')
    expect(i18nSource).toContain('{tool} 在此时段内暂无活动')
  })

  it.each(pages)('shows the idle hint on empty tool-filtered views (%s)', (rel) => {
    const source = readSource(rel)
    expect(source).toContain('common.toolIdleHint')
    expect(source).toContain('$selectedTool')
  })

  it('reads an out-of-range tool as idle on the overview byTool table', () => {
    const overview = readSource('../src/routes/overview/+page.svelte')
    expect(overview).toContain('!data.byTool[$selectedTool]')
    expect(overview).toContain('common.toolIdleHint')
  })
})
