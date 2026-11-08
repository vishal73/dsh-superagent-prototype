import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { telegramKind } from '../src/sources/telegram.ts'
import { githubKind } from '../src/sources/github.ts'
import { snapshot, threadSummary, ticketSummary, triggerView } from '../src/app/views/records.ts'
import { basisFacts, ticketDetail } from '../src/app/views/tickets.ts'
import { threadDetail } from '../src/app/views/threads.ts'
import { droppedReplies, sourcesStatus } from '../src/app/views/sources.ts'
import { overview } from '../src/app/views/overview.ts'
import { markdown, plain } from '../src/app/views/text.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { KV } from '../src/kv.ts'
import { telegramLink } from '../src/sources/telegram-channel.ts'
import { telegramChannel, telegramTriggerId } from '../src/sources/telegram-trigger.ts'
import { githubLink } from '../src/sources/github-channel.ts'
import { githubChannel } from '../src/sources/github-trigger.ts'
import { followupOwners, type ChannelRef } from '../src/core/index.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-views-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const links = (channel: ChannelRef) => (channel.source === 'telegram' ? telegramLink : githubLink)(channel.address, {})
const drop = (id: string, channel: ChannelRef, ticketId?: string) => {
  const message = { id, channel, text: id, kind: 'reply' as const, ...ticketId ? { ticketId } : {} }
  store.receipts.add(message)
  store.receipts.settle(message, 'channelGone')
}

it('names the Thread of each dropped message: the one its Channel names, or the one the stored Trigger belongs to', () => {
  // A Telegram Channel's address names its Thread: a reply carries the root message the reply chain starts at.
  store.threads.save({ key: 'telegram:-100123:1', ref: { source: 'telegram', id: '-100123:1' }, createdAt: '', subscriptions: [],
    correlated: [], pending: [], meta: {} })
  store.threads.save({ key: 'github:42', ref: { source: 'github', id: '42' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
    meta: {} })
  drop('a', telegramChannel('-100123', '2', undefined, undefined, '1'))
  drop('b', githubChannel(42))
  // A message whose Thread the store no longer has links nowhere.
  drop('c', telegramChannel('-100777', '99'))
  expect(Object.fromEntries(droppedReplies({ store, links }).map(item => [item.id, item.thread])))
    .toEqual({ a: 'telegram:-100123:1', b: 'github:42', c: undefined })
})

function views() {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { telegram: { allowed: [{ id: '42', name: 'Alice' }] },
    github: { allowed: [{ id: 'alice' }] } },
    rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }] } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(telegramKind); sources.register(githubKind)
  return { store, sources, links }
}
const at = new Date().toISOString()
/** A live ticket with no Assignment, as a follow-up's owner needs one. */
const live = (id: string) => store.tickets.save({ id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at,
  updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'telegram', id: '42' }, scope: '' },
  origin: { triggerId: 'e0', triggerIds: ['e0'] }, assignments: [], inputs: [] })
const message = (id: string, actor: { source: string; id: string }, human = true) => ({ id, source: actor.source,
  threads: [{ source: 'telegram', id: '-100123:1' }], actor, human, at, text: `message ${id}`, meta: {} })

it('names each sender as the Policy lists it, by its id where the id is readable, and as its kind names one it does not list', () => {
  const view = snapshot(views())
  expect([view.actor({ source: 'telegram', id: '42' }), view.actor({ source: 'github', id: 'alice' }), view.actor({ source: 'github',
    id: 'bob' }),
    view.actor({ source: 'telegram', id: '43' }), view.actor({ source: 'telegram', id: '99' }, false), view.actor({ source: 'telegram',
      id: '' })])
    .toEqual([{ source: 'telegram', id: '42', name: { zh: 'Alice', en: 'Alice' } }, { source: 'github', id: 'alice',
      name: { zh: 'alice', en: 'alice' } },
      { source: 'github', id: 'bob', name: { zh: 'bob', en: 'bob' } }, { source: 'telegram', id: '43',
        name: telegramKind.policy!.unnamed!.person },
      { source: 'telegram', id: '99', name: telegramKind.policy!.unnamed!.bot }, { source: 'telegram', id: '' }])
  expect(view.rule('copy')).toEqual({ id: 'copy', name: 'Copy fixes' })
  expect(view.rule('gone')).toEqual({ id: 'gone', name: 'gone' })
})

it('classifies a Thread by what it is doing, and offers a filtered Trigger of a person to Eval again', () => {
  const host = views()
  store.threads.save({ key: 'telegram:-100123:1', ref: { source: 'telegram', id: '-100123:1' }, createdAt: at, subscriptions: [],
    correlated: [],
    pending: ['e2'], meta: {} })
  store.triggers.save(message('e1', { source: 'telegram', id: '42' }))
  store.triggers.save(message('e2', { source: 'telegram', id: '43' }))
  store.triggers.save(message('e3', { source: 'telegram', id: '99' }, false))
  for (const id of ['e1', 'e3']) store.triggers.saveDisposition(id, { filtered: { code: 'not_a_member' }, fanout: [], at })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('telegram:-100123:1')!).stage).toBe('queued')
  const rows = ['e1', 'e2', 'e3'].map(id => triggerView(view, store.triggers.get(id)!))
  // A queued Trigger waits for Eval already, and an automated one is not offered.
  expect(rows.map(row => row.actions.requeue)).toEqual([true, false, false])
  expect(rows[0]!.actor.name).toEqual({ zh: 'Alice', en: 'Alice' })
})

it('states each Source by the first state that holds', () => {
  const host = views()
  const states = (setup: Parameters<typeof sourcesStatus>[2], health: Parameters<typeof sourcesStatus>[1] = {}) =>
    Object.fromEntries(sourcesStatus(host, health, setup).map(source => [source.id, source.state]))
  expect(states({})).toEqual({ telegram: 'starting', github: 'starting' })
  expect(states({}, { telegram: { state: 'paused', detail: '' }, github: { state: 'error', detail: 'x' } }))
    .toEqual({ telegram: 'paused', github: 'error' })
  const problem = { place: 'deployment', code: 'stateDirUnset', values: {}, detail: '' } as never
  expect(states({ problem }, { telegram: { state: 'ready', detail: '' }, github: { state: 'ready', detail: '' } }))
    .toEqual({ telegram: 'setup', github: 'setup' })
})

it('follows the Ticket\'s stage: a blocked Ticket a person answered since is working, with no retry, note or turn end', () => {
  const host = views()
  const blocked = { state: 'blocked' as const, summary: 'Needs the design file', at: '2026-09-22T00:01:00Z' }
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit' as const, policyVersion: 'v', basis: { via: 'listed' as const }, actor: { source: 'telegram',
      id: '42' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [{ id: 'a1', state: 'running' as const, createdAt: at, startedAt: at,
      report: blocked }],
    inputs: [] as { id: string; kind: 'trigger'; triggerId: string; at: string; human?: true }[] }
  store.tickets.save(ticket)
  const row = ticketSummary(store.tickets.get('t1')!)
  expect(row).toMatchObject({ stage: 'person', action: 'blocked', actions: { retry: true }, note: { text: 'Needs the design file',
    error: false } })
  expect(ticketDetail(host, 't1')!.assignments[0]).toMatchObject({ turnEndedAt: blocked.at })
  store.tickets.save({ ...ticket, inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:02:00Z', human: true }] })
  const answered = ticketSummary(store.tickets.get('t1')!)
  expect(answered).toMatchObject({ stage: 'working', actions: { retry: false } })
  expect(answered).not.toHaveProperty('note')
  expect(ticketDetail(host, 't1')!.assignments[0]).not.toHaveProperty('turnEndedAt')
})

it('does not show a follow-up that reached a ticket as waiting for an Eval, though an older version queued it', () => {
  const host = views()
  live('t1')
  store.triggers.save(message('f1', { source: 'telegram', id: '42' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'telegram', id: '43' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, at })
  store.threads.save({ key: 'telegram:-100123:1', ref: { source: 'telegram', id: '-100123:1' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: ['f1'], meta: {} })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('telegram:-100123:1')!)).toMatchObject({ stage: 'subscribed', pending: 0 })
  expect(triggerView(view, store.triggers.get('f1')!).disposition.queued).toBe(false)
  // One a person sent to Eval again waits for it.
  store.threads.save({ ...store.threads.get('telegram:-100123:1')!, pending: ['f1', 'f2'] })
  expect(threadSummary(snapshot(host), store.threads.get('telegram:-100123:1')!)).toMatchObject({ stage: 'queued', pending: 1 })
})

const load = { running: 0, queued: 0 }
const problems = (host: ReturnType<typeof views>, health: Parameters<typeof overview>[1] = {}) =>
  overview(host, health, 'v1', load).problems

it('lists an Eval past its deadline, and as dsh-superagent\'s own errors only parts no Source or Policy sync reports', () => {
  const host = views()
  const evaluating = { id: 'e1', threadKey: 'github:1', triggerIds: ['t1'], strength: 'explicit' as const, actor: { source: 'github',
    id: 'alice' },
    basis: { via: 'addressed' as const, addressed: 'mention' as const }, policyVersion: 'v1', startedAt: '2026-01-01T00:00:00Z',
    deadline: '2026-01-01T00:02:00Z' }
  store.threads.save({ key: 'github:1', ref: { source: 'github', id: '1' }, createdAt: at, subscriptions: [], correlated: [], pending: [],
    evaluating, meta: {} })
  const error = (detail: string) => ({ state: 'error' as const, detail })
  const health = { relay: error('relay failing'), reply: error('reply failing'), telegram: error('poll failed'),
    'sync:telegram': error('sync failed'), evals: error('unavailable'), launch: { state: 'ready' as const, detail: '' } }
  const found = problems(host, health)
  expect(found).toContainEqual({ kind: 'eval-overdue', thread: expect.objectContaining({ key: 'github:1', stage: 'evaluating' }) })
  // Effects are dsh-superagent's own; a Source shows its parts and its Policy sync, and the Evals are listed one by one.
  expect(found.filter(item => item.kind === 'runtime-error')).toEqual([{ kind: 'runtime-error', name: 'relay', detail: 'relay failing' },
    { kind: 'runtime-error', name: 'reply', detail: 'reply failing' }])
  expect(found.filter(item => item.kind === 'source-error').map(item => item.source.health.name)).toEqual(['telegram'])
})

it('says no Source runs when every Source is off, and states a Source missing or off', () => {
  const host = views()
  expect(problems(host).map(item => item.kind)).not.toContain('no-source')
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { telegram: { enabled: false, config: {} }, github: { enabled: false, config: {} },
    jira: { enabled: true, config: { site: 'acme' } } } })
  expect(problems(host).map(item => item.kind)).toContain('no-source')
  expect(Object.fromEntries(sourcesStatus(host, {}, {}).map(source => [source.id, [source.state, source.installed]])))
    .toEqual({ telegram: ['off', true], github: ['off', true], jira: ['missing', false] })
})

it('sends text without HTML, entity-encoded tags included, and with images named', () => {
  const text = '<div>Hello <b>there</b></div> &lt;script&gt;alert(1)&lt;/script&gt; <!-- note --> ![shot](https://x/y.png) [Image: diagram]'
  expect(plain(text)).toBe('Hello there alert(1) [image] [image]')
  expect(markdown(`**Fix** ${text}\n\n- one`)).toBe('**Fix** Hello there alert(1)  [image] [image]\n\n- one')
  expect(plain('[the docs](https://example.com) and `code` &amp; more')).toBe('the docs and code & more')
})

it('words each settings save by what it changed from the one before, and nothing after a gap in the history', () => {
  const host = views()
  const first = store.settings()
  const allowed = (entries: { id: string; name?: string }[]) => ({ ...first.policy, sources: { ...first.policy.sources,
    telegram: { ...first.policy.sources.telegram!, allowed: entries } } })
  const alice = { id: '42', name: 'Alice Liu' }, bob = { id: '43', name: 'Bob' }
  store.saveSettings({ ...first, policy: allowed([alice, bob, { id: '44' }]), paused: true,
    sources: { ...first.sources, telegram: { enabled: false, config: {} } },
    executor: { ...first.executor, directory: '/srv/work', prepare: 'npm ci', blockedCommands: ['rm', 'curl'] } })
  const second = store.settings()
  store.saveSettings({ ...second, policy: allowed([alice, { id: '44' }]), paused: false, sources: { ...second.sources,
    telegram: { enabled: true, config: {} } } })
  const changes = (revision: number) => policyHistory(store, host.sources, 'v').items.find(item => item.revision === revision)!.changes
  const revision = store.get(KV.settings.revision)!
  expect(changes(revision - 1)).toEqual([
    { code: 'sourceRowsAdded', source: 'telegram', part: true, field: 'allowed', items: ['Bob', '44'] },
    { code: 'sourceRowsChanged', source: 'telegram', part: true, field: 'allowed', items: ['Alice Liu'] },
    { code: 'paused' }, { code: 'executionDirectory', from: '', to: '/srv/work' }, { code: 'prepareCommand' },
    { code: 'blockedCommands', from: '', to: 'rm curl' }, { code: 'sourceDisabled', source: 'telegram' }])
  expect(changes(revision)).toEqual([{ code: 'sourceRowsRemoved', source: 'telegram', part: true, field: 'allowed', items: ['Bob'] },
    { code: 'resumed' }, { code: 'sourceEnabled', source: 'telegram' }])
  // A save whose predecessor is missing from the history has nothing to compare with.
  store.delete(KV.settings.version(revision))
  store.saveSettings({ ...store.settings(), paused: true })
  expect(changes(revision + 1)).toBeNull()
})

it('names a listed bot as the Policy lists it, and gives a bot\'s Mandate a basis fact of its own', () => {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { telegram: { allowed: [], bots: [{ id: '99', name: '评审机器人' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(telegramKind)
  const view = snapshot({ store, sources, links })
  expect(view.actor({ source: 'telegram', id: '99' }, false).name).toEqual({ zh: '评审机器人', en: '评审机器人' })
  expect(basisFacts({ via: 'bot', sender: '评审机器人', addressed: 'mention', observation: { mode: 'auto' } }, view.rule).facts)
    .toEqual([{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'addressed', value: 'mention' }, { name: 'mode', value: 'auto' }])
})

it('shows a follow-up that reached a ticket as delivered, the tickets that handed a Trigger back with why, and the Threads a ticket follows for context', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'telegram:-100123:1', ref: { source: 'telegram', id: '-100123:1' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'telegram', id: '42' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'telegram', id: '42' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, handbacks: [{ ticketId: 't1', reason: 'Asks for a new feature', at }], at })
  const view = snapshot(host)
  expect(triggerView(view, store.triggers.get('f1')!).disposition).toMatchObject({ delivered: true, queued: false, handbacks: [] })
  // A Trigger handed back goes to Eval as any message on its Thread; the Ticket that handed it back is named by its title once it has one.
  expect(triggerView(view, store.triggers.get('f2')!).disposition).toMatchObject({ delivered: false,
    handbacks: [{ ticketId: 't1', title: 't1', reason: 'Asks for a new feature' }] })
  store.threads.save({ key: 'github:7', ref: { source: 'github', id: '7' }, createdAt: at, subscriptions: ['t1'], context: ['t1'],
    correlated: [], pending: [], meta: {} })
  expect(threadDetail(host, 'github:7', undefined, 50)?.context).toEqual(['t1'])
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'telegram', id: '42' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'f1', at }, { id: 'i2', kind: 'trigger', triggerId: 'f2', at }] })
  const page = ticketDetail(host, 't1')!
  expect(Object.fromEntries(page.threads.map(thread => [thread.key, !!thread.context]))).toEqual({ 'telegram:-100123:1': false,
    'github:7': true })
  expect(page.inputs.map(input => input.kind === 'trigger' && input.trigger?.handback)).toEqual([{ reason: 'Asks for a new feature', at },
    undefined])
  expect(triggerView(snapshot(host), store.triggers.get('f2')!).disposition.handbacks[0]?.title).toBe('Fix')
})

it('names a bot\'s Mandate as a bot once the Policy no longer lists it', () => {
  const host = views()
  const mandate = { strength: 'inferred' as const, policyVersion: 'v', basis: { via: 'bot' as const,
    observation: { mode: 'auto' as const } },
    actor: { source: 'telegram', id: '99' }, scope: '' }
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at, mandate,
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [] })
  expect(ticketDetail(host, 't1')!.mandate.actor).toEqual({ source: 'telegram', id: '99', name: telegramKind.policy!.unnamed!.bot })
})

it('offers a person to send a follow-up to Eval while a ticket decides it, or once nothing did', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'telegram:-100123:1', ref: { source: 'telegram', id: '-100123:1' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'telegram', id: '42' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  const row = () => triggerView(snapshot(host), store.triggers.get('f1')!)
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: true } })
  // A ticket that ended after its worker had it leaves it to nobody: a person may still send it to Eval.
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: false } })
  // Not once its worker acknowledged it, which took it up; a stop on it decided only the ticket's work.
  store.triggers.saveDisposition('f1', { fanout: ['t1'], acked: ['t1'], at })
  expect(row().actions.requeue).toBe(false)
  store.decisions.save({ id: 'stop', evalId: 'e', threadKey: 'telegram:-100123:1', triggerIds: ['f1'], policyVersion: 'v', at, kind: 'stop',
    reason: [{ code: 'humanStop' }], strength: 'explicit', ticketId: 't1' })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // So once the stop ended the ticket, which let go of the message, as the Engine records it.
  store.triggers.saveDisposition('f1', { fanout: [], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // Once sent, it waits for the Eval.
  store.threads.save({ ...store.threads.get('telegram:-100123:1')!, pending: ['f1'] })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], requeued: true, at })
  expect(row()).toMatchObject({ actions: { requeue: false }, disposition: { queued: true } })
})

it('reads each ticket a page\'s follow-ups reached once, and nothing for a message no ticket can decide', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'telegram:-100123:1', ref: { source: 'telegram', id: '-100123:1' }, createdAt: at, subscriptions: ['t1'],
    correlated: [], pending: [], meta: {} })
  for (const id of ['f1', 'f2', 'f3']) {
    store.triggers.save(message(id, { source: 'telegram', id: '42' }))
    store.triggers.saveDisposition(id, { fanout: ['t1'], at })
  }
  const view = snapshot(host)
  const tickets = vi.spyOn(store.tickets, 'get')
  expect(['f1', 'f2', 'f3'].map(id => triggerView(view, store.triggers.get(id)!).disposition.delivered)).toEqual([true, true, true])
  expect(tickets).toHaveBeenCalledOnce()
  tickets.mockRestore()
  // A message the ticket handed back is decided by no ticket, which needs no read.
  store.triggers.saveDisposition('f3', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'Another change', at }], at })
  const records = { tickets: { get: vi.fn() }, threads: { get: vi.fn() }, triggers: store.triggers }
  expect(followupOwners(store.triggers.get('f3')!, records)).toEqual([])
  expect([records.tickets.get, records.threads.get].map(read => read.mock.calls.length)).toEqual([0, 0])
})
