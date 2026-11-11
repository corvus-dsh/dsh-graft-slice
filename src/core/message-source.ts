import { GRAFT_REPLAY_SOURCE_KIND } from './host-shape.js'
import { isRecord } from '../utils/serialize.js'

export function isGraftAuthored(source: unknown): boolean {
  if (!isRecord(source)) return false
  const kind = source.kind
  if (typeof kind !== 'string') return false
  return kind === GRAFT_REPLAY_SOURCE_KIND || kind.startsWith('plugin:graft')
}

export function isHumanAuthored(source: unknown): boolean {
  return isRecord(source) && source.kind === 'user'
}
