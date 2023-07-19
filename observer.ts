import { connect as connectAmqp } from "https://deno.land/x/amqp@v0.23.1/mod.ts";

import { Buffer } from "node:buffer";
import { AbiEvent } from "npm:abitype";
import {
  Chain,
  createPublicClient,
  http as httpViemTransport,
  toBytes,
  toHex,
} from "npm:viem";

import type { PrismaClient } from "./generated/client/deno/edge.ts";

import {
  ReloadControlMessage,
  deserializeControlMessage,
} from "./ControlMessage.ts";
import { serializeEventMessage } from "./EventMessage.ts";
import {
  ControlExchangeName,
  ControlObserverRoutingKey,
  EvmEventsQueueName,
} from "./constants.ts";

export async function observer(chain: Chain, prisma: PrismaClient) {
  const client = createPublicClient({
    chain,
    transport: httpViemTransport(),
  });

  // TODO: configuration
  const amqpConnection = await connectAmqp();
  const amqpChannel = await amqpConnection.openChannel();
  await amqpChannel.declareExchange({ exchange: ControlExchangeName });
  const controlQueue = await amqpChannel.declareQueue({});
  await amqpChannel.bindQueue({
    queue: controlQueue.queue,
    exchange: ControlExchangeName,
    routingKey: ControlObserverRoutingKey,
  });
  await amqpChannel.declareQueue({ queue: EvmEventsQueueName });
  let unwatchEvents = await CreateWatch();
  await amqpChannel.consume(
    { queue: controlQueue.queue },
    async (_args, _props, data) => {
      if (
        deserializeControlMessage(data).action === ReloadControlMessage.action
      ) {
        unwatchEvents.forEach((unwatch) => unwatch());
        unwatchEvents = await CreateWatch();
      }
    },
  );

  return { unwatchEvents };

  async function CreateWatch() {
    return (await prisma.eventSource.findMany({
      select: { abiHash: true, address: true, Abi: { select: { json: true } } },
    })).map((item) => {
      const event = JSON.parse(item.Abi.json) as AbiEvent;
      return client.watchEvent({
        address: toHex(item.address as unknown as Uint8Array),
        event,
        onLogs: async (logs) => {
          for (const log of logs) {
            if (log.blockNumber == null) throw new Error("blockNumber is null");
            if (log.transactionIndex == null) {
              throw new Error("txIndex is null");
            }
            if (log.logIndex == null) throw new Error("logIndex is null");
            if (log.blockHash == null) throw new Error("blockHash is null");
            if (log.transactionHash == null) throw new Error("txHash is null");

            const timestamp =
              (await client.getBlock({ blockHash: log.blockHash! })).timestamp;
            const blockHashBytes = toBytes(log.blockHash);
            const addressBytes = toBytes(log.address);
            const topicsBytes = log.topics.map(toBytes).map(Buffer.from);

            await prisma.event.create({
              data: {
                blockTimestamp: new Date(Number(timestamp) * 1000),
                txIndex: log.transactionIndex,
                logIndex: log.logIndex,
                blockNumber: Number(log.blockNumber),
                blockHash: Buffer.from(blockHashBytes),
                txHash: Buffer.from(toBytes(log.transactionHash)),
                sourceAddress: Buffer.from(addressBytes),
                abiHash: item.abiHash,
                topic1: topicsBytes[1],
                topic2: topicsBytes[2],
                topic3: topicsBytes[3],
                data: Buffer.from(toBytes(log.data)),
              },
            });

            amqpChannel.publish(
              { routingKey: EvmEventsQueueName },
              { contentType: "application/octet-stream" },
              serializeEventMessage({
                address: addressBytes,
                sigHash: item.abiHash as unknown as Uint8Array,
                topics: topicsBytes,
                blockTimestamp: timestamp,
                txIndex: BigInt(log.transactionIndex),
                logIndex: BigInt(log.logIndex),
                blockNumber: log.blockNumber,
                blockHash: blockHashBytes,
              }),
            );
          }
        },
      });
    });
  }
}
