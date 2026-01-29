#!/usr/bin/env node
/**
 * Channel opening utility for Voltage LND node
 * Usage: node channel-open.js [action] [args]
 * 
 * Actions:
 *   info          - Get node info
 *   balance       - Get wallet balance  
 *   peers         - List connected peers
 *   connect       - Connect to a peer: node channel-open.js connect <pubkey>@<host>:<port>
 *   open          - Open channel: node channel-open.js open <pubkey> <amount_sats>
 *   channels      - List channels
 *   pay           - Pay invoice: node channel-open.js pay <bolt11_invoice>
 */

require('dotenv').config();

const LND_REST_URL = process.env.LND_REST_URL;
const LND_MACAROON = process.env.LND_MACAROON;

if (!LND_REST_URL || !LND_MACAROON) {
  console.error('Error: LND_REST_URL and LND_MACAROON must be set in .env');
  process.exit(1);
}

async function lndRequest(endpoint, options = {}) {
  const url = `${LND_REST_URL}${endpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    'Grpc-Metadata-macaroon': LND_MACAROON,
  };
  
  console.log(`→ ${options.method || 'GET'} ${endpoint}`);
  
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    console.error('LND API error:', data);
    throw new Error(data.message || data.error || `LND API error: ${response.status}`);
  }
  
  return data;
}

// Well-known nodes for connecting
const WELL_KNOWN_NODES = {
  'acinq': '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f@node.acinq.co:9735',
  'kraken': '02f1a8c87607f415c8f22c00593002775941dea48869ce23096af27b0cfdcc0b69@52.13.118.208:9735',
  'wos': '035e4ff418fc8b5554c5d9eea66396c227bd429a3251c8cbc711002ba215bfc226@170.75.163.209:9735',
  'opennode': '03abf6f44c355dec0d5aa155bdbdd6e0c8fefe318eff402de65c6eb2e1be55dc3e@18.221.23.28:9735',
  'bitfinex': '033d8656219478701227199cbd6f670335c8d408a92ae88b962c49d4dc0e83e025@98.84.17.125:9735',
  'muun': '038f8f113c580048d847d6949371726653e02b928196bad310e3eda39ff61723f6@34.239.230.56:9735',
};

async function getInfo() {
  const info = await lndRequest('/v1/getinfo');
  console.log('\n=== Node Info ===');
  console.log(`Alias: ${info.alias}`);
  console.log(`Pubkey: ${info.identity_pubkey}`);
  console.log(`Block Height: ${info.block_height}`);
  console.log(`Synced to Chain: ${info.synced_to_chain}`);
  console.log(`Synced to Graph: ${info.synced_to_graph}`);
  console.log(`Active Channels: ${info.num_active_channels}`);
  console.log(`Pending Channels: ${info.num_pending_channels}`);
  console.log(`Peers: ${info.num_peers}`);
  if (info.uris && info.uris.length > 0) {
    console.log(`\nNode URIs:`);
    info.uris.forEach(uri => console.log(`  ${uri}`));
  }
  return info;
}

async function getBalance() {
  const onchain = await lndRequest('/v1/balance/blockchain');
  const offchain = await lndRequest('/v1/balance/channels');
  
  console.log('\n=== Wallet Balance ===');
  console.log(`On-chain (confirmed): ${parseInt(onchain.confirmed_balance).toLocaleString()} sats`);
  console.log(`On-chain (unconfirmed): ${parseInt(onchain.unconfirmed_balance).toLocaleString()} sats`);
  console.log(`On-chain (total): ${parseInt(onchain.total_balance).toLocaleString()} sats`);
  console.log(`\nChannel Balance: ${parseInt(offchain.balance || 0).toLocaleString()} sats`);
  console.log(`Pending Open: ${parseInt(offchain.pending_open_balance || 0).toLocaleString()} sats`);
  
  return { onchain, offchain };
}

async function listPeers() {
  const result = await lndRequest('/v1/peers');
  const peers = result.peers || [];
  
  console.log(`\n=== Connected Peers (${peers.length}) ===`);
  if (peers.length === 0) {
    console.log('No peers connected');
  } else {
    peers.forEach(p => {
      console.log(`  ${p.pub_key}`);
      console.log(`    Address: ${p.address}`);
      console.log(`    Inbound: ${p.inbound}`);
      console.log(`    Sat Sent: ${p.sat_sent}, Sat Recv: ${p.sat_recv}`);
    });
  }
  return peers;
}

async function connectPeer(peerUri) {
  // Parse pubkey@host:port format
  let pubkey, host;
  
  // Check if it's a well-known alias
  if (WELL_KNOWN_NODES[peerUri.toLowerCase()]) {
    peerUri = WELL_KNOWN_NODES[peerUri.toLowerCase()];
    console.log(`Using well-known node: ${peerUri}`);
  }
  
  const match = peerUri.match(/^([0-9a-f]{66})@(.+)$/i);
  if (!match) {
    console.error('Invalid peer URI format. Expected: <pubkey>@<host>:<port>');
    console.log('\nAvailable aliases:', Object.keys(WELL_KNOWN_NODES).join(', '));
    return null;
  }
  
  pubkey = match[1];
  host = match[2];
  
  console.log(`\nConnecting to peer...`);
  console.log(`  Pubkey: ${pubkey}`);
  console.log(`  Host: ${host}`);
  
  try {
    const result = await lndRequest('/v1/peers', {
      method: 'POST',
      body: JSON.stringify({
        addr: { pubkey, host },
        perm: true,
        timeout: 30,
      }),
    });
    
    console.log('✓ Connection initiated');
    
    // Wait and verify
    console.log('\nWaiting for connection to establish...');
    await new Promise(r => setTimeout(r, 3000));
    
    const peers = await lndRequest('/v1/peers');
    const connected = (peers.peers || []).find(p => p.pub_key === pubkey);
    
    if (connected) {
      console.log('✓ Peer connected successfully!');
      return connected;
    } else {
      console.log('⚠ Connection initiated but peer not yet in list. May take a moment.');
      return result;
    }
  } catch (err) {
    if (err.message.includes('already connected')) {
      console.log('✓ Already connected to this peer');
      return { already_connected: true };
    }
    throw err;
  }
}

async function openChannel(pubkey, amountSats) {
  // Check if it's a well-known alias
  if (WELL_KNOWN_NODES[pubkey.toLowerCase()]) {
    const uri = WELL_KNOWN_NODES[pubkey.toLowerCase()];
    pubkey = uri.split('@')[0];
    console.log(`Using well-known node pubkey: ${pubkey}`);
  }
  
  if (!/^[0-9a-f]{66}$/i.test(pubkey)) {
    console.error('Invalid pubkey format. Expected 66 hex characters.');
    return null;
  }
  
  const amount = parseInt(amountSats);
  if (isNaN(amount) || amount < 20000) {
    console.error('Invalid amount. Minimum channel size is 20,000 sats.');
    return null;
  }
  
  console.log(`\n=== Opening Channel ===`);
  console.log(`  Peer: ${pubkey}`);
  console.log(`  Amount: ${amount.toLocaleString()} sats`);
  
  // First check balance
  const balance = await lndRequest('/v1/balance/blockchain');
  const available = parseInt(balance.confirmed_balance);
  
  if (available < amount + 10000) { // 10k buffer for fees
    console.error(`Insufficient balance. Have ${available.toLocaleString()} sats, need ${(amount + 10000).toLocaleString()} sats (including fee buffer)`);
    return null;
  }
  
  // Open channel - use streaming endpoint for proper response
  console.log('\nInitiating channel open...');
  
  try {
    // The pubkey needs to be base64 encoded for the REST API
    const pubkeyBase64 = Buffer.from(pubkey, 'hex').toString('base64');
    
    const result = await lndRequest('/v1/channels', {
      method: 'POST',
      body: JSON.stringify({
        node_pubkey: pubkeyBase64,
        local_funding_amount: amount.toString(),
        push_sat: '0',
        target_conf: 3, // Target 3 block confirmation
        private: false,
        min_htlc_msat: '1000',
      }),
    });
    
    console.log('✓ Channel open initiated!');
    console.log(`  Funding txid: ${result.funding_txid_str || result.funding_txid_bytes || 'pending'}`);
    
    return result;
  } catch (err) {
    // Check if peer is online
    if (err.message.includes('not online')) {
      console.error('\n✗ Peer is not online. Try connecting first:');
      console.error(`  node channel-open.js connect ${pubkey}@<host>:<port>`);
    }
    throw err;
  }
}

async function payInvoice(bolt11) {
  if (!bolt11 || !bolt11.toLowerCase().startsWith('lnbc')) {
    console.error('Invalid bolt11 invoice. Must start with lnbc (mainnet)');
    return null;
  }
  
  console.log(`\n=== Paying Invoice ===`);
  console.log(`Invoice: ${bolt11.slice(0, 40)}...`);
  
  // Decode invoice first to see amount
  try {
    const decoded = await lndRequest('/v1/payreq/' + bolt11);
    console.log(`  Amount: ${parseInt(decoded.num_satoshis).toLocaleString()} sats`);
    console.log(`  Description: ${decoded.description || '(none)'}`);
    console.log(`  Expires: ${new Date(parseInt(decoded.timestamp) * 1000 + parseInt(decoded.expiry) * 1000).toLocaleString()}`);
  } catch (err) {
    console.log(`  (Could not decode invoice: ${err.message})`);
  }
  
  console.log('\nSending payment...');
  
  try {
    const result = await lndRequest('/v1/channels/transactions', {
      method: 'POST',
      body: JSON.stringify({
        payment_request: bolt11,
      }),
    });
    
    if (result.payment_error) {
      console.error(`✗ Payment failed: ${result.payment_error}`);
      return null;
    }
    
    const paymentHashHex = result.payment_hash 
      ? Buffer.from(result.payment_hash, 'base64').toString('hex')
      : 'unknown';
    
    console.log('✓ Payment successful!');
    console.log(`  Payment hash: ${paymentHashHex}`);
    console.log(`  Amount: ${parseInt(result.value_sat || 0).toLocaleString()} sats`);
    console.log(`  Fee: ${parseInt(result.fee_sat || 0).toLocaleString()} sats`);
    
    return result;
  } catch (err) {
    console.error(`✗ Payment failed: ${err.message}`);
    throw err;
  }
}

async function listChannels() {
  const result = await lndRequest('/v1/channels');
  const channels = result.channels || [];
  
  const pending = await lndRequest('/v1/channels/pending');
  const pendingOpen = pending.pending_open_channels || [];
  
  console.log(`\n=== Channels ===`);
  console.log(`Active: ${channels.length}, Pending: ${pendingOpen.length}`);
  
  if (pendingOpen.length > 0) {
    console.log('\n-- Pending Open --');
    pendingOpen.forEach(p => {
      const ch = p.channel;
      console.log(`  ${ch.remote_node_pub}`);
      console.log(`    Capacity: ${parseInt(ch.capacity).toLocaleString()} sats`);
      console.log(`    Local: ${parseInt(ch.local_balance).toLocaleString()} sats`);
      console.log(`    Confirmations: ${p.confirmation_height || 'waiting'}`);
    });
  }
  
  if (channels.length > 0) {
    console.log('\n-- Active --');
    channels.forEach(ch => {
      console.log(`  ${ch.remote_pubkey}`);
      console.log(`    Capacity: ${parseInt(ch.capacity).toLocaleString()} sats`);
      console.log(`    Local: ${parseInt(ch.local_balance).toLocaleString()} sats`);
      console.log(`    Remote: ${parseInt(ch.remote_balance).toLocaleString()} sats`);
      console.log(`    Active: ${ch.active}`);
    });
  }
  
  if (channels.length === 0 && pendingOpen.length === 0) {
    console.log('No channels');
  }
  
  return { channels, pendingOpen };
}

async function main() {
  const [,, action, ...args] = process.argv;
  
  if (!action) {
    console.log('LND Channel Management Tool');
    console.log('Usage: node channel-open.js <action> [args]\n');
    console.log('Actions:');
    console.log('  info              - Get node info');
    console.log('  balance           - Get wallet balance');
    console.log('  peers             - List connected peers');
    console.log('  connect <uri>     - Connect to peer (pubkey@host:port or alias)');
    console.log('  open <pubkey> <amount> - Open channel');
    console.log('  channels          - List channels');
    console.log('\nWell-known aliases:', Object.keys(WELL_KNOWN_NODES).join(', '));
    return;
  }
  
  try {
    switch (action.toLowerCase()) {
      case 'info':
        await getInfo();
        break;
      case 'balance':
        await getBalance();
        break;
      case 'peers':
        await listPeers();
        break;
      case 'connect':
        if (!args[0]) {
          console.error('Usage: node channel-open.js connect <pubkey@host:port>');
          console.log('Or use an alias:', Object.keys(WELL_KNOWN_NODES).join(', '));
          return;
        }
        await connectPeer(args[0]);
        break;
      case 'open':
        if (!args[0] || !args[1]) {
          console.error('Usage: node channel-open.js open <pubkey|alias> <amount_sats>');
          return;
        }
        await openChannel(args[0], args[1]);
        break;
      case 'channels':
        await listChannels();
        break;
      case 'pay':
        if (!args[0]) {
          console.error('Usage: node channel-open.js pay <bolt11_invoice>');
          return;
        }
        await payInvoice(args[0]);
        break;
      default:
        console.error(`Unknown action: ${action}`);
    }
  } catch (err) {
    console.error(`\n✗ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
