import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import WebSocket from 'ws';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import axios from 'axios';
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction, PublicKey, SystemProgram, MessageV0, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { Buffer } from 'buffer';
import dotenv from 'dotenv';
dotenv.config();
// --- CONFIGURATION & CONSTANTS ---
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.QUICKNODE_RPC_URL;
const PUMP_PORTAL_WS = 'wss://pumpportal.fun/api/data';
const JUPITER_SWAP_URL = 'https://public.jupiterapi.com/pump-fun/swap';
const FEE_WALLET = new PublicKey('E6koZ5XwDhYWpQ3ua5B8u2QN9q5agJm98Rva7Ay4AVPS');
const FEE_PERCENTAGE = 0.005; // 0.5%
const MAX_TASKS_PER_SECOND = 7;
if (!RPC_URL)
    throw new Error("FATAL ERROR: QUICKNODE_RPC_URL is not defined.");
// --- SERVER & SOCKET.IO SETUP ---
const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "*" } });
const connection = new Connection(RPC_URL, 'confirmed');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const taskQueue = [];
const activeTasks = new Map();
const tokenSubscriptions = new Map();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// --- HELPER FUNCTIONS ---
function getKeypairFromPrivateKey(privateKey) {
    try {
        return Keypair.fromSecretKey(bs58.decode(privateKey));
    }
    catch (error) {
        throw new Error('Invalid private key format.');
    }
}
function emitLog(socketId, taskId, message, type = 'info') {
    const logEntry = { message, type, timestamp: new Date().toLocaleTimeString() };
    console.log(`[${new Date().toISOString()}] [${taskId.slice(0, 6)}] [${type.toUpperCase()}] - ${message}`);
    io.to(socketId).emit('log', logEntry);
}
function emitStatusUpdate(socketId, taskId) {
    const task = activeTasks.get(taskId);
    if (!task)
        return;
    const taskUpdatePayload = {
        taskId: task.taskId,
        status: task.status,
        totalSpentSOL: task.totalSpentSOL,
        maxAmountSOL: task.maxAmountSOL,
    };
    io.to(socketId).emit('taskUpdate', taskUpdatePayload);
}
// ❗️ REFACTORED: This function now prepares the data for any admin client.
function getTasksForAdmin() {
    return Array.from(activeTasks.values()).map(task => ({
        taskId: task.taskId,
        tokenAddress: task.tokenAddress,
        operatorId: task.userKeypair.publicKey.toBase58(),
        bumpAmountSOL: task.bumpAmountSOL,
        inactivityThresholdSeconds: task.inactivityThresholdSeconds,
        totalSpentSOL: task.totalSpentSOL,
        maxAmountSOL: task.maxAmountSOL,
        status: task.status,
    }));
}
// This broadcast function is now simpler.
function broadcastActiveTasks() {
    io.emit('tasksUpdate', getTasksForAdmin());
}
// --- WebSocket Manager ---
let ws = null;
let reconnectTimeout = null;
function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }
    console.log('Attempting to connect to PumpPortal WebSocket...');
    ws = new WebSocket(PUMP_PORTAL_WS);
    ws.on('open', () => {
        console.log('✅ WebSocket connection to PumpPortal established.');
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
        const allTokens = Array.from(tokenSubscriptions.keys());
        if (allTokens.length > 0) {
            console.log(`Resubscribing to ${allTokens.length} tokens...`);
            const payload = { method: "subscribeTokenTrade", keys: allTokens };
            ws?.send(JSON.stringify(payload));
        }
    });
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            if (message && message.mint && message.txType === 'buy') {
                const taskIds = tokenSubscriptions.get(message.mint);
                if (taskIds) {
                    taskIds.forEach(taskId => {
                        const task = activeTasks.get(taskId);
                        if (task) {
                            task.lastBuyTimestamp = Date.now();
                            emitLog(task.socketId, taskId, `Detected external buy for ${message.mint.slice(0, 6)}... Resetting timer.`, 'info');
                        }
                    });
                }
            }
        }
        catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    });
    ws.on('close', () => {
        console.warn('WebSocket connection closed. Attempting to reconnect in 5 seconds...');
        ws = null;
        if (!reconnectTimeout) {
            reconnectTimeout = setTimeout(connectWebSocket, 5000);
        }
    });
    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        ws?.close();
    });
}
function subscribeToToken(tokenAddress, taskId) {
    if (!tokenSubscriptions.has(tokenAddress)) {
        tokenSubscriptions.set(tokenAddress, new Set());
        const payload = { method: "subscribeTokenTrade", keys: [tokenAddress] };
        ws?.send(JSON.stringify(payload));
        console.log(`Subscribed to trades for token: ${tokenAddress}`);
    }
    tokenSubscriptions.get(tokenAddress).add(taskId);
}
function unsubscribeFromToken(tokenAddress, taskId) {
    if (tokenSubscriptions.has(tokenAddress)) {
        const tasks = tokenSubscriptions.get(tokenAddress);
        tasks.delete(taskId);
        if (tasks.size === 0) {
            tokenSubscriptions.delete(tokenAddress);
            const payload = { method: "unsubscribeTokenTrade", keys: [tokenAddress] };
            ws?.send(JSON.stringify(payload));
            console.log(`Unsubscribed from trades for token: ${tokenAddress}`);
        }
    }
}
// --- MASTER PROCESSOR & INACTIVITY CHECKER ---
function startMasterProcessor() {
    // Transaction Executor
    setInterval(async () => {
        const tasksToProcess = taskQueue.splice(0, MAX_TASKS_PER_SECOND);
        if (tasksToProcess.length > 0) {
            const promises = tasksToProcess.map(async ({ taskId }) => {
                const task = activeTasks.get(taskId);
                if (task && !task.stop) {
                    try {
                        await executeTransactionForTask(task);
                    }
                    catch (error) {
                        const errorMessage = error.response?.data ? JSON.stringify(error.response.data) : error.message;
                        emitLog(task.socketId, taskId, `❌ Processor Error: ${errorMessage}`, 'error');
                        console.error(`[${taskId.slice(0, 6)}] Full Error in batch:`, error);
                    }
                    finally {
                        if (task)
                            task.isBuying = false;
                    }
                }
            });
            await Promise.allSettled(promises);
        }
    }, 1000);
    // Inactivity Checker
    setInterval(() => {
        const now = Date.now();
        activeTasks.forEach(task => {
            if (task.stop || !task.inactivityThresholdMs || task.isBuying)
                return;
            if (task.totalSpentSOL >= task.maxAmountSOL) {
                task.status = 'completed';
                emitLog(task.socketId, task.taskId, 'Maximum spend limit reached. Mission complete.', 'success');
                stopTask(task.taskId);
                return;
            }
            const timeSinceLastBuy = now - task.lastBuyTimestamp;
            if (timeSinceLastBuy > task.inactivityThresholdMs) {
                emitLog(task.socketId, task.taskId, `Inactivity threshold reached (${task.inactivityThresholdSeconds}s). Queuing buy.`, 'warn');
                task.isBuying = true;
                taskQueue.push({ taskId: task.taskId });
            }
        });
    }, 1500);
    // Admin Broadcaster for live updates
    setInterval(() => {
        broadcastActiveTasks();
    }, 2000);
}
async function executeTransactionForTask(task) {
    emitLog(task.socketId, task.taskId, `Processing bump of ${task.bumpAmountSOL} SOL...`, 'info');
    const { data } = await axios.post(JUPITER_SWAP_URL, {
        wallet: task.userKeypair.publicKey.toBase58(),
        type: 'BUY',
        mint: task.tokenAddress,
        inAmount: String(Math.floor(task.bumpAmountSOL * LAMPORTS_PER_SOL)),
        slippageBps: 1500,
        priorityFeeLevel: 'high',
    });
    if (!data || !data.tx) {
        throw new Error("Failed to get transaction from Jupiter API.");
    }
    const transactionBuffer = Buffer.from(data.tx, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuffer);
    transaction.sign([task.userKeypair]);
    const signature = await connection.sendTransaction(transaction, { skipPreflight: true, maxRetries: 2 });
    emitLog(task.socketId, task.taskId, `Swap sent (${signature.slice(0, 8)}...), awaiting confirmation.`, 'info');
    await connection.confirmTransaction(signature, 'confirmed');
    task.totalSpentSOL += task.bumpAmountSOL;
    task.lastBuyTimestamp = Date.now();
    const solscanLink = `https://solscan.io/tx/${signature}`;
    const successMessage = `✅ Swap success! | Spent: ${task.bumpAmountSOL.toFixed(4)} SOL | View: ${solscanLink}`;
    emitLog(task.socketId, task.taskId, successMessage, 'success');
    emitStatusUpdate(task.socketId, task.taskId);
    await sendFeeSeparately(task);
}
async function sendFeeSeparately(task) {
    emitLog(task.socketId, task.taskId, `💸 Processing 0.5% fee payment...`, 'info');
    try {
        const feeAmountSOL = task.bumpAmountSOL * FEE_PERCENTAGE;
        const feeAmountLamports = Math.floor(feeAmountSOL * LAMPORTS_PER_SOL);
        if (feeAmountLamports <= 0)
            return;
        const priorityFeeInstruction = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 });
        const feeTransferInstruction = SystemProgram.transfer({
            fromPubkey: task.userKeypair.publicKey,
            toPubkey: FEE_WALLET,
            lamports: feeAmountLamports,
        });
        const { blockhash } = await connection.getLatestBlockhash();
        const message = MessageV0.compile({
            payerKey: task.userKeypair.publicKey,
            instructions: [priorityFeeInstruction, feeTransferInstruction],
            recentBlockhash: blockhash,
        });
        const feeTransaction = new VersionedTransaction(message);
        feeTransaction.sign([task.userKeypair]);
        const signature = await connection.sendTransaction(feeTransaction, { skipPreflight: true });
        await connection.confirmTransaction(signature, 'confirmed');
        emitLog(task.socketId, task.taskId, `✅ Fee sent successfully. Signature: ${signature.slice(0, 10)}...`, 'success');
    }
    catch (error) {
        emitLog(task.socketId, task.taskId, `❌ Failed to send fee: ${error.message}`, 'error');
    }
}
function stopTask(taskId) {
    const task = activeTasks.get(taskId);
    if (task) {
        task.stop = true;
        if (task.status !== 'completed')
            task.status = 'stopped';
        unsubscribeFromToken(task.tokenAddress, taskId);
        emitLog(task.socketId, taskId, 'Mission has been stopped.', 'warn');
        emitStatusUpdate(task.socketId, taskId);
    }
}
// --- SOCKET.IO CONNECTION HANDLER ---
io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Client connected: ${socket.id}`);
    // ❗️ FIXED: Add a listener for the admin page's request.
    socket.on('requestInitialAdminData', () => {
        console.log(`Admin client ${socket.id} requested initial data. Sending.`);
        // Immediately send the current list of tasks to the admin client that just connected.
        socket.emit('tasksUpdate', getTasksForAdmin());
    });
    socket.on('startTask', (taskData) => {
        try {
            const { privateKey, tokenAddress, bumpAmount, inactivityInterval, maxAmount } = taskData;
            if (!privateKey || !tokenAddress || !bumpAmount || !inactivityInterval || !maxAmount) {
                throw new Error("Missing required task data.");
            }
            const userKeypair = getKeypairFromPrivateKey(privateKey);
            const taskId = crypto.randomUUID();
            const task = {
                taskId,
                socketId: socket.id,
                userKeypair,
                tokenAddress,
                bumpAmountSOL: parseFloat(bumpAmount),
                inactivityThresholdSeconds: parseInt(inactivityInterval, 10),
                inactivityThresholdMs: parseInt(inactivityInterval, 10) * 1000,
                maxAmountSOL: parseFloat(maxAmount),
                totalSpentSOL: 0,
                status: 'active',
                stop: false,
                lastBuyTimestamp: Date.now(),
                isBuying: false,
            };
            activeTasks.set(taskId, task);
            subscribeToToken(tokenAddress, taskId);
            socket.emit('taskStarted', { taskId });
            emitLog(socket.id, taskId, `Mission engaged. Target: ${tokenAddress.slice(0, 6)}...`);
            emitLog(socket.id, taskId, `Monitoring: Will buy if no purchases detected for ${task.inactivityThresholdSeconds} seconds.`, 'info');
        }
        catch (error) {
            console.error(`[${new Date().toISOString()}] [ERROR] Task failed to start:`, error);
            socket.emit('error', { message: `Task failed to start: ${error.message}` });
        }
    });
    socket.on('stopTask', ({ taskId }) => {
        if (taskId)
            stopTask(taskId);
    });
    socket.on('disconnect', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected: ${socket.id}`);
        activeTasks.forEach((task, taskId) => {
            if (task.socketId === socket.id) {
                stopTask(taskId);
            }
        });
    });
});
// --- API & STATIC FILE ROUTES ---
app.post('/api/derive-pubkey', (req, res) => {
    try {
        const { privateKey } = req.body;
        if (!privateKey)
            throw new Error('Private key is required.');
        const keypair = getKeypairFromPrivateKey(privateKey);
        res.status(200).json({ publicKey: keypair.publicKey.toBase58() });
    }
    catch (error) {
        res.status(400).json({ message: error.message });
    }
});
app.get('/admin', (req, res) => {
    // Make sure your admin.html file is located in a 'public' sub-directory
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
// --- SERVER INITIALIZATION ---
httpServer.listen(PORT, () => {
    console.log(`🚀 Server with Sockets running on http://localhost:${PORT}`);
    connectWebSocket();
    startMasterProcessor();
});
