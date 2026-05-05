import { Kafka, type Producer, type Consumer, logLevel } from 'kafkajs';
import { env } from './config.js';

export const kafka = new Kafka({
  clientId: env.KAFKA_CLIENT_ID,
  brokers: env.KAFKA_BROKERS.split(',').map((s) => s.trim()),
  logLevel: logLevel.WARN,
});

let producer: Producer | null = null;

/** Lazily-initialized shared Kafka producer. The poller publishes CDC ops here. */
export async function getProducer(): Promise<Producer> {
  if (producer) return producer;
  const p = kafka.producer({ allowAutoTopicCreation: true });
  await p.connect();
  producer = p;
  return p;
}

/** Spin up a fresh consumer in the supplied group. The apply consumer creates one per job. */
export async function newConsumer(groupId: string): Promise<Consumer> {
  const c = kafka.consumer({ groupId });
  await c.connect();
  return c;
}

export async function shutdownKafka(): Promise<void> {
  if (producer) {
    await producer.disconnect().catch(() => {});
    producer = null;
  }
}
