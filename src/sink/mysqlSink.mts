import { SqlSink } from './sqlSink.mjs';

// MySQL sink. Behaviour lives in SqlSink; this subclass exists for identity and
// as the home for any future MySQL-specific divergence.
export class MysqlSink extends SqlSink { }
