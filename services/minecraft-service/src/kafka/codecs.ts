// kafkajs is CJS; CompressionCodecs is attached dynamically and invisible to
// Node's ESM named-export lexer — hence the default import.
import kafkajs from 'kafkajs'
// @ts-expect-error kafkajs-snappy ships no types
import SnappyCodec from 'kafkajs-snappy'

const { CompressionCodecs, CompressionTypes } = kafkajs

// kafkajs has no built-in Snappy codec, but peers legally may compress with it
// (rpk does by default) — without this, the consumer crashes on the first
// snappy batch. Import for side effect before any Kafka client is created.
CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec
