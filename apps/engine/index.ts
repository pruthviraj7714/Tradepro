import redisclient from "@repo/redisclient";
import {
  CONSUMER_NAME,
  ENGINE_STREAM,
  GROUP_NAME,
  RESULTS_STREAM,
} from "./config";
import fs from "fs";
import type {
  IEventData,
  IOrder,
  IPriceData,
  UserBalanceWallet,
} from "./types/types";
import { DecimalsMap } from "@repo/common";

let prices: Record<string, IPriceData> = {};
let balances: Record<string, UserBalanceWallet> = {};
let openOrders: Record<string, IOrder[]> = {};
let lastStreamId: string;

function parseStreamData(streams: any[]) {
  const results: any[] = [];
  for (const [, entries] of streams) {
    for (const [id, fields] of entries) {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        obj[fields[i]] = fields[i + 1];
      }
      if (obj.data) {
        results.push({ streamId: id, ...JSON.parse(obj.data) });
      }
    }
  }
  return results;
}

const createConsumerGroup = async () => {
  try {
    await redisclient.xgroup(
      "CREATE",
      ENGINE_STREAM,
      GROUP_NAME,
      "$",
      "MKSTREAM",
    );
  } catch (error: any) {
    if (error.message.includes("BUSYGROUP")) {
      console.log(`Group with ${GROUP_NAME} already exists`);
    } else {
      console.error(error);
    }
  }
};

const saveSnapshot = async () => {
  const tmpPath = "./snapshot.tmp.json";
  const finalPath = "./snapshot.json";
  const backupPath = "./snapshot.backup.json";

  const currState = {
    timestamp: Date.now(),
    openOrders,
    balances,
    price: prices,
    lastStreamId,
  };

  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(currState));

    if (fs.existsSync(finalPath)) {
      await fs.promises.copyFile(finalPath, backupPath);
    }

    await fs.promises.rename(tmpPath, finalPath);
  } catch (err) {
    console.error("Snapshot save failed:", err);
  }
};
const restoreSnapshot = () => {
  for (const path of ["./snapshot.json", "./snapshot.backup.json"]) {
    try {
      if (!fs.existsSync(path)) continue;
      const data = fs.readFileSync(path, "utf-8");
      const rawData = JSON.parse(data);
      openOrders = rawData.openOrders || {};
      balances = rawData.balances || {};
      prices = rawData.price || {};
      lastStreamId = rawData.lastStreamId || "0";
      console.log(`Snapshot restored from ${path} at streamId:`, lastStreamId);
      return;
    } catch (err) {
      console.error(`Failed to restore from ${path}:`, err);
    }
  }
  console.warn("No valid snapshot found, starting fresh");
};

const autoCloseOrder = async (order: IOrder) => {
  const assetPrice = prices[order.asset]!;
  const usdtDecimals = DecimalsMap["USDT"]!;
  const { userId } = order;

  const openPrice = order.openPrice / 10 ** assetPrice.decimal;

  let currentPrice =
    order.type === "LONG"
      ? assetPrice.bid / 10 ** assetPrice.decimal
      : assetPrice.ask / 10 ** assetPrice.decimal;

  const pnl =
    order.type === "LONG"
      ? (currentPrice - openPrice) * order.qty!
      : (openPrice - currentPrice) * order.qty!;

  order.pnl = pnl * 10 ** usdtDecimals;

  if (!balances[userId]) {
    balances[userId] = {
      freeMargin: 5000,
      usedMargin: 0,
    };
  }

  const marginFloat = order.margin / 10 ** usdtDecimals;

  balances[userId].usedMargin -= marginFloat;
  balances[userId].freeMargin += marginFloat + pnl;

  let finalOrderData = {
    ...order,
    closePrice: currentPrice,
    event: "ORDER_CLOSED",
    closedAt: Date.now(),
    finalBalance: balances[userId].freeMargin * 10 ** usdtDecimals,
  };

  openOrders[order.userId] = (openOrders[order.userId] || []).filter(
    (odr) => odr.id !== order.id,
  );

  await redisclient.xack(ENGINE_STREAM, GROUP_NAME, order.streamId);
  lastStreamId = order.streamId;
  await redisclient.xadd(
    RESULTS_STREAM,
    "*",
    "data",
    JSON.stringify(finalOrderData),
  );
};

const handleCalculatePNL = async (order: IOrder, currentPrices: IPriceData) => {
  let pnl: number;

  let openPrice = order.openPrice / 10 ** currentPrices.decimal;

  let currentPrice =
    order.type === "LONG"
      ? currentPrices.bid / 10 ** currentPrices.decimal
      : currentPrices.ask / 10 ** currentPrices.decimal;

  pnl =
    order.type === "LONG"
      ? (currentPrice - openPrice) * order.qty!
      : (openPrice - currentPrice) * order.qty!;

  const usdtDecimals = DecimalsMap["USDT"]!;

  const orderMargin = order.margin / 10 ** usdtDecimals;

  const positionSize = orderMargin * order.leverage;
  const unrealizedLoss = -pnl;
  const marginUsedPercent = unrealizedLoss / positionSize;

  if (marginUsedPercent >= 0.9) {
    console.log("Order is closing due to low margin (liquidation)");

    await autoCloseOrder(order);
  }
};

const handlePriceUpdate = async (latestPrices: Record<string, IPriceData>) => {
  const pnlPromises = Object.values(openOrders)
    .flat()
    .map((order) => {
      return handleCalculatePNL(order, latestPrices[order.asset]!);
    });

  const results = await Promise.allSettled(pnlPromises);

  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    console.error("Failed to process PNL for " + failures.length + " orders");
  }
};

const processPlaceOrder = async (event: IEventData) => {
  try {
    if (event.event === "PLACE_ORDER") {
      const { asset, leverage, id, margin, slippage, type, userId } =
        event.data;

      balances[userId] = balances[userId] || {
        freeMargin: 5000,
        usedMargin: 0,
      };

      if (!prices[asset]) {
        console.log(`No price data available for ${asset}. Order rejected.`);
        let errorData = {
          type: "ERROR",
          errorStatus: 503,
          streamId: event.streamId,
          errorMessage: `Price not available for ${asset}. Please try again later.`,
          id,
        };
        await redisclient.xack(ENGINE_STREAM, GROUP_NAME, event.streamId);
        lastStreamId = event.streamId;
        await redisclient.xadd(
          RESULTS_STREAM,
          "*",
          "data",
          JSON.stringify(errorData),
        );
        return;
      }

      if (balances[userId].freeMargin < margin) {
        console.log("Insufficient Balance");
        let errorData = {
          type: "ERROR",
          errorStatus: 403,
          streamId: event.streamId,
          errorMessage: `Your balance is too low to place this order.`,
          id: event.data.id,
        };
        await redisclient.xack(ENGINE_STREAM, GROUP_NAME, event.streamId);
        lastStreamId = event.streamId;
        await redisclient.xadd(
          RESULTS_STREAM,
          "*",
          "data",
          JSON.stringify(errorData),
        );
        return;
      }

      openOrders[userId] = openOrders[userId] || [];

      const refPrice =
        type === "LONG"
          ? prices[asset].ask / 10 ** prices[asset].decimal
          : prices[asset].bid / 10 ** prices[asset]?.decimal;

      if (!refPrice) {
        console.log("open price not found!");
        return;
      }

      const tolerence = slippage / 100;
      let minAcceptable: number, maxAcceptable: number;

      if (type === "LONG") {
        minAcceptable = refPrice;
        maxAcceptable = refPrice * (1 + tolerence);
      } else {
        maxAcceptable = refPrice;
        minAcceptable = refPrice * (1 - tolerence);
      }

      const executionPrice =
        type === "LONG"
          ? prices[asset].ask / 10 ** prices[asset].decimal
          : prices[asset].bid / 10 ** prices[asset].decimal;

      if (executionPrice < minAcceptable || executionPrice > maxAcceptable) {
        console.log("Slippage is too high order can't proceed");
        let errorData = {
          type: "ERROR",
          errorStatus: 422,
          streamId: event.streamId,
          errorMessage: `Slippage too high. Order rejected.`,
          id: event.data.id,
        };
        await redisclient.xack(ENGINE_STREAM, GROUP_NAME, event.streamId);
        lastStreamId = event.streamId;
        await redisclient.xadd(
          RESULTS_STREAM,
          "*",
          "data",
          JSON.stringify(errorData),
        );
        return;
      }

      const usdtDecimals = DecimalsMap["USDT"]!;
      const symbolDecimals = DecimalsMap[event.data.asset]!;

      const quantity = (margin * leverage) / executionPrice;

      balances[userId].freeMargin -= margin;
      balances[userId].usedMargin += margin;

      let orderData: IOrder = {
        id: id,
        asset: asset,
        leverage: leverage,
        margin: margin * 10 ** usdtDecimals,
        slippage: slippage,
        type: type,
        userId: userId,
        event: "ORDER_PLACED",
        openPrice: executionPrice * 10 ** symbolDecimals,
        qty: quantity,
        streamId: event.streamId,
        openedAt: Date.now(),
      };

      openOrders[userId].push(orderData);

      await redisclient.xack(ENGINE_STREAM, GROUP_NAME, event.streamId);
      lastStreamId = event.streamId;
      const result = await redisclient.xadd(
        RESULTS_STREAM,
        "*",
        "data",
        JSON.stringify(orderData),
      );
      console.log(result);
    }
  } catch (error) {
    console.error(
      "error while processing order: " + event.id + "err: " + error,
    );
  }
};

const processCancelOrder = async (event: IEventData) => {
  try {
    if (event.event === "CANCEL_ORDER") {
      const { orderId, userId } = event.data;
      const usdtDecimals = DecimalsMap["USDT"]!;

      const order = (openOrders[userId] || []).find(
        (order) => order.id === orderId,
      );

      if (!order) {
        console.log("order not found!");
        let errorData = {
          type: "ERROR",
          errorStatus: 400,
          streamId: event.streamId,
          errorMessage: `Order with orderId ${orderId} not found!`,
          id: orderId,
        };
        await redisclient.xack(ENGINE_STREAM, GROUP_NAME, event.streamId);
        lastStreamId = event.streamId;
        await redisclient.xadd(
          RESULTS_STREAM,
          "*",
          "data",
          JSON.stringify(errorData),
        );
        return;
      }

      const assetPrice = prices[order.asset]!;

      let currentPrice =
        order.type === "LONG"
          ? assetPrice.bid / 10 ** assetPrice.decimal
          : assetPrice.ask / 10 ** assetPrice.decimal;

      const openPrice = order.openPrice / 10 ** assetPrice.decimal;

      const pnl =
        order.type === "LONG"
          ? (currentPrice - openPrice) * order.qty!
          : (openPrice - currentPrice) * order.qty!;

      order.pnl = pnl * 10 ** usdtDecimals;

      const symbolDecimals = DecimalsMap[order.asset]!;

      if (!balances[userId]) {
        balances[userId] = { freeMargin: 5000, usedMargin: 0 };
      }

      const marginFloat = order.margin / 10 ** usdtDecimals;

      balances[userId].usedMargin -= marginFloat;
      balances[userId].freeMargin += marginFloat + pnl;

      let finalOrderData = {
        ...order,
        userId,
        event: "ORDER_CLOSED",
        closedAt: Date.now(),
        closePrice: currentPrice * 10 ** symbolDecimals,
        finalBalance: balances[userId].freeMargin! * 10 ** usdtDecimals,
      };

      console.log(finalOrderData);

      openOrders[userId] =
        (openOrders[userId] || []).filter((order) => order.id !== orderId) ||
        [];

      await redisclient.xack(ENGINE_STREAM, GROUP_NAME, event.streamId);
      lastStreamId = event.streamId;
      await redisclient.xadd(
        RESULTS_STREAM,
        "*",
        "data",
        JSON.stringify(finalOrderData),
      );
    }
  } catch (error) {
    console.error(
      "error while processing order: " + event.id + "err: " + error,
    );
  }
};

const processEvents = async (events: IEventData[]) => {
  for (const event of events) {
    switch (event.event) {
      case "PLACE_ORDER": {
        await processPlaceOrder(event);
        break;
      }
      case "CANCEL_ORDER": {
        await processCancelOrder(event);
        break;
      }
      case "PRICE_UPDATE": {
        try {
          if (event.data) {
            Object.keys(event.data).forEach(
              (val: string) =>
                (prices[val] = {
                  decimal: event.data[val]!.decimal,
                  bid: event.data[val]!.bid,
                  ask: event.data[val]!.ask,
                }),
            );
          }
          await handlePriceUpdate(prices);
          await redisclient.xack(ENGINE_STREAM, GROUP_NAME, event.streamId);
          lastStreamId = event.streamId;
        } catch (error) {
          console.error("Error while processing price update: ", error);
        }
        break;
      }
      default: {
        throw new Error("Unknown events");
      }
    }
  }
};

async function main() {
  restoreSnapshot();

  await createConsumerGroup();

  const prevMessages = await redisclient.xreadgroup(
    "GROUP",
    GROUP_NAME,
    CONSUMER_NAME,
    "BLOCK",
    5000,
    "STREAMS",
    ENGINE_STREAM,
    lastStreamId || "0",
  );

  if (prevMessages && prevMessages.length > 0) {
    const data = parseStreamData(prevMessages);
    await processEvents(data);
  }

  while (true) {
    try {
      const newMessages = await redisclient.xreadgroup(
        "GROUP",
        GROUP_NAME,
        CONSUMER_NAME,
        "BLOCK",
        5000,
        "STREAMS",
        ENGINE_STREAM,
        ">",
      );

      if (newMessages && newMessages.length > 0) {
        const data = parseStreamData(newMessages);
        await processEvents(data);
      }
    } catch (error) {
      console.error("Error in main loop: ", error);
    }
  }
}

main();
setInterval(saveSnapshot, 5000);
