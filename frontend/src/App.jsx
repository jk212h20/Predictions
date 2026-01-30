import { useState, useEffect, useCallback, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import * as api from './api';
import BotAdmin from './BotAdmin';
import UserAdmin from './UserAdmin';
import './App.css';

// Constants
const SATS_PER_SHARE = 1000;

// Format satoshis
const formatSats = (sats) => {
  if (!sats) return '0';
  return sats.toLocaleString();
};

// Calculate number of shares from sats
const satsToShares = (sats) => {
  if (!sats) return 0;
  return Math.floor(sats / SATS_PER_SHARE);
};

// Format shares with optional sats in parentheses
const formatShares = (sats, showSats = false) => {
  const shares = satsToShares(sats);
  if (showSats) {
    return `${shares.toLocaleString()} shares (${formatSats(sats)} sats)`;
  }
  return `${shares.toLocaleString()} share${shares !== 1 ? 's' : ''}`;
};

// ==================== AUTH CONTEXT ====================
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      api.getUser()
        .then(setUser)
        .catch(() => localStorage.removeItem('token'))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const { token, user } = await api.login(email, password);
    localStorage.setItem('token', token);
    setUser(user);
  };

  const register = async (email, password, username) => {
    const { token, user } = await api.register(email, password, username);
    localStorage.setItem('token', token);
    setUser(user);
  };

  const googleLogin = async (credential) => {
    const { token, user } = await api.googleLogin(credential);
    localStorage.setItem('token', token);
    setUser(user);
  };

  const lightningLogin = async (k1) => {
    const { token, user } = await api.completeLnurlAuth(k1);
    localStorage.setItem('token', token);
    setUser(user);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  const refreshBalance = async () => {
    if (user) {
      const { balance_sats } = await api.getBalance();
      setUser(prev => ({ ...prev, balance_sats }));
    }
  };

  const updateUser = (updatedUser) => {
    setUser(updatedUser);
  };

  return { user, loading, login, register, googleLogin, lightningLogin, logout, refreshBalance, updateUser };
}

// ==================== COMPONENTS ====================

function Header({ user, onLogout, onShowWallet, onShowPortfolio, onShowProfile, onShowAdmin, onShowBotAdmin, onShowUserAdmin, onShowLogin, onGoHome }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleMobileAction = (action) => {
    setMobileMenuOpen(false);
    action();
  };

  return (
    <header className="header">
      <div className="header-left" onClick={onGoHome} style={{ cursor: 'pointer' }}>
        <h1>₿itcoin Chess 960 Championship</h1>
        <span className="header-date">Prospera • March 16-22, 2026</span>
      </div>
      <div className="header-right">
        {user ? (
          <>
            <span className="balance" onClick={onShowWallet}>
              ⚡ {formatSats(user.balance_sats)} sats
            </span>
            <button className="btn btn-small btn-portfolio" onClick={onShowPortfolio}>
              📊 Portfolio
            </button>
            <button className="btn btn-small btn-profile" onClick={onShowProfile}>
              👤 {user.username || user.email?.split('@')[0] || 'Profile'}
            </button>
            {user.is_admin === 1 && (
              <>
                <button className="btn btn-small btn-bot" onClick={onShowBotAdmin}>🤖 Bot</button>
                <button className="btn btn-small btn-users" onClick={onShowUserAdmin}>👥 Users</button>
                <button className="btn btn-small" onClick={onShowAdmin}>Admin</button>
              </>
            )}
            <button className="btn btn-small btn-outline" onClick={onLogout}>Logout</button>
            {/* Mobile Menu Button */}
            <button 
              className="mobile-menu-btn" 
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Menu"
            >
              {mobileMenuOpen ? '✕' : '☰'}
            </button>
          </>
        ) : (
          <button className="btn btn-small btn-login" onClick={onShowLogin}>Login to trade ⚡</button>
        )}
      </div>
      {/* Mobile Menu Dropdown */}
      {user && (
        <div className={`header-actions-mobile ${mobileMenuOpen ? 'open' : ''}`}>
          <button className="btn btn-portfolio" onClick={() => handleMobileAction(onShowPortfolio)}>
            📊 Portfolio
          </button>
          <button className="btn btn-profile" onClick={() => handleMobileAction(onShowProfile)}>
            👤 Profile
          </button>
          {user.is_admin === 1 && (
            <>
              <button className="btn btn-bot" onClick={() => handleMobileAction(onShowBotAdmin)}>
                🤖 Market Maker Bot
              </button>
              <button className="btn btn-outline" onClick={() => handleMobileAction(onShowAdmin)}>
                🔐 Admin Panel
              </button>
            </>
          )}
          <button className="btn btn-outline" onClick={() => handleMobileAction(onLogout)}>
            Logout
          </button>
        </div>
      )}
    </header>
  );
}

// Lightning Login Modal with QR code and polling
function LightningLoginModal({ onComplete, onClose }) {
  const [challenge, setChallenge] = useState(null);
  const [status, setStatus] = useState('loading'); // loading, ready, polling, verified, error
  const [error, setError] = useState('');
  const pollingRef = useRef(null);

  // Generate challenge on mount
  useEffect(() => {
    generateChallenge();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const generateChallenge = async () => {
    setStatus('loading');
    setError('');
    try {
      const data = await api.getLnurlAuthChallenge();
      setChallenge(data);
      setStatus('ready');
      startPolling(data.k1);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const startPolling = (k1) => {
    // Poll every 2 seconds
    pollingRef.current = setInterval(async () => {
      try {
        const statusData = await api.getLnurlAuthStatus(k1);
        if (statusData.status === 'verified') {
          clearInterval(pollingRef.current);
          setStatus('verified');
          // Complete the login
          await onComplete(k1);
          onClose();
        } else if (statusData.status === 'expired') {
          clearInterval(pollingRef.current);
          setError('Challenge expired. Please try again.');
          setStatus('error');
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 2000);
  };

  const handleCopyLnurl = () => {
    if (challenge?.encoded) {
      navigator.clipboard.writeText(challenge.encoded);
      alert('LNURL copied to clipboard!');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal lightning-modal" onClick={e => e.stopPropagation()}>
        <h2>⚡ Login with Lightning</h2>
        
        {status === 'loading' && (
          <div className="lightning-loading">
            <div className="spinner"></div>
            <p>Generating login challenge...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="lightning-error">
            <p className="auth-error">{error}</p>
            <button className="btn btn-primary" onClick={generateChallenge}>
              Try Again
            </button>
          </div>
        )}

        {(status === 'ready' || status === 'polling') && challenge && (
          <div className="lightning-qr-container">
            <p className="lightning-instructions">
              Scan this QR code with your Lightning wallet<br />
              <span className="lightning-hint">(Phoenix, Alby, Zeus, Wallet of Satoshi, etc.)</span>
            </p>
            
            <div className="qr-wrapper">
              <QRCodeSVG 
                value={challenge.uri}
                size={256}
                level="M"
                includeMargin={true}
                className="lightning-qr"
              />
            </div>

            <div className="lightning-waiting">
              <div className="pulse-dot"></div>
              <span>Waiting for wallet signature...</span>
            </div>

            <div className="lightning-actions">
              <a 
                href={challenge.uri} 
                className="btn btn-primary btn-lightning-open"
              >
                Open in Wallet App
              </a>
              <button 
                className="btn btn-outline"
                onClick={handleCopyLnurl}
              >
                Copy LNURL
              </button>
            </div>

            <p className="lightning-note">
              No account needed! Your Lightning wallet creates a unique, private login key for this site.
            </p>
          </div>
        )}

        {status === 'verified' && (
          <div className="lightning-success">
            <div className="success-icon">✓</div>
            <p>Signature verified! Logging you in...</p>
          </div>
        )}

        <button className="btn btn-outline modal-close" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function LoginModal({ onLogin, onRegister, onGoogleLogin, onLightningLogin, onClose, onSwitchToLightning }) {
  const [mode, setMode] = useState('login'); // 'login' or 'register'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [googleClientId, setGoogleClientId] = useState(null);
  const googleButtonRef = useRef(null);

  // Load Google Sign-In
  useEffect(() => {
    const loadGoogleSignIn = async () => {
      try {
        const { clientId } = await api.getGoogleClientId();
        setGoogleClientId(clientId);
      } catch (err) {
        // Google OAuth not configured, that's okay
        console.log('Google OAuth not configured');
      }
    };
    loadGoogleSignIn();
  }, []);

  // Initialize Google Sign-In button when clientId is available
  useEffect(() => {
    if (!googleClientId || !googleButtonRef.current) return;

    // Load Google Identity Services script
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.google) {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: handleGoogleResponse,
        });
        window.google.accounts.id.renderButton(
          googleButtonRef.current,
          { 
            theme: 'filled_black', 
            size: 'large', 
            width: '100%',
            text: 'continue_with'
          }
        );
      }
    };
    document.body.appendChild(script);

    return () => {
      // Cleanup
      const existingScript = document.querySelector('script[src="https://accounts.google.com/gsi/client"]');
      if (existingScript) existingScript.remove();
    };
  }, [googleClientId]);

  const handleGoogleResponse = async (response) => {
    setLoading(true);
    setError('');
    try {
      await onGoogleLogin(response.credential);
      onClose();
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (mode === 'register') {
      if (password !== confirmPassword) {
        setError('Passwords do not match');
        return;
      }
      if (password.length < 6) {
        setError('Password must be at least 6 characters');
        return;
      }
    }
    
    setLoading(true);
    try {
      if (mode === 'login') {
        await onLogin(email, password);
      } else {
        await onRegister(email, password, username);
      }
      onClose();
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setError('');
    setPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{mode === 'login' ? 'Login' : 'Create Account'}</h2>
        
        {googleClientId && (
          <>
            <div ref={googleButtonRef} className="google-signin-btn"></div>
            <div className="login-divider">
              <span>or continue with email</span>
            </div>
          </>
        )}
        
        {error && <div className="auth-error">{error}</div>}
        
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          
          {mode === 'register' && (
            <>
              <input
                type="password"
                placeholder="Confirm Password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
              />
              <input
                type="text"
                placeholder="Username (optional)"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
              />
            </>
          )}
          
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading...' : (mode === 'login' ? 'Login' : 'Create Account')}
          </button>
        </form>
        
        <div className="auth-switch">
          {mode === 'login' ? (
            <p>Don't have an account? <button type="button" onClick={switchMode}>Sign up</button></p>
          ) : (
            <p>Already have an account? <button type="button" onClick={switchMode}>Login</button></p>
          )}
        </div>
        
        {mode === 'register' && (
          <p className="modal-note">
            New accounts receive 100,000 sats for testing.
          </p>
        )}

        <div className="login-divider">
          <span>or</span>
        </div>
        
        <button 
          type="button" 
          className="btn btn-lightning-login"
          onClick={onSwitchToLightning}
        >
          ⚡ Login with Lightning
        </button>
        <p className="lightning-login-hint">
          No email needed — sign in with your Lightning wallet
        </p>
      </div>
    </div>
  );
}

// Parse BOLT11 invoice to extract amount in satoshis
const decodeBolt11Amount = (invoice) => {
  if (!invoice) return null;
  const lower = invoice.toLowerCase();
  
  // BOLT11 format: ln[network][amount][multiplier]1[data]
  // Network: bc (mainnet), tb (testnet), bcrt (regtest)
  const match = lower.match(/^ln(bc|tb|bcrt)(\d+)([munp])?1/);
  if (!match) {
    // No amount in invoice (zero-amount invoice)
    return null;
  }
  
  const amount = parseInt(match[2], 10);
  const multiplier = match[3];
  
  // Convert to satoshis based on multiplier
  // Base unit is millisatoshi for lightning
  let sats;
  switch (multiplier) {
    case 'm': // milli-bitcoin = 0.001 BTC = 100,000 sats
      sats = amount * 100000;
      break;
    case 'u': // micro-bitcoin = 0.000001 BTC = 100 sats
      sats = amount * 100;
      break;
    case 'n': // nano-bitcoin = 0.000000001 BTC = 0.1 sats
      sats = Math.ceil(amount / 10);
      break;
    case 'p': // pico-bitcoin = 0.000000000001 BTC = 0.0001 sats
      sats = Math.ceil(amount / 10000);
      break;
    default: // No multiplier means whole bitcoin
      sats = amount * 100000000;
      break;
  }
  
  return sats;
};

function WalletModal({ user, onClose, onRefresh }) {
  // Lightning deposit state
  const [depositAmount, setDepositAmount] = useState(100000);
  const [invoice, setInvoice] = useState(null);
  const [depositStatus, setDepositStatus] = useState('idle');
  const [depositError, setDepositError] = useState('');
  
  // On-chain deposit state
  const [onchainAddress, setOnchainAddress] = useState(null);
  const [onchainDeposits, setOnchainDeposits] = useState([]);
  const [onchainDepositStatus, setOnchainDepositStatus] = useState('idle');
  const [onchainDepositError, setOnchainDepositError] = useState('');
  
  // Unified withdraw state
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawInvoice, setWithdrawInvoice] = useState('');
  const [withdrawAddress, setWithdrawAddress] = useState('');
  const [withdrawStatus, setWithdrawStatus] = useState('idle');
  const [withdrawResult, setWithdrawResult] = useState(null);
  const [withdrawError, setWithdrawError] = useState('');
  const [pendingWithdrawals, setPendingWithdrawals] = useState([]);
  const [onchainPendingWithdrawals, setOnchainPendingWithdrawals] = useState([]);
  const [cancellingId, setCancellingId] = useState(null);
  const pollingRef = useRef(null);

  // Load data on mount
  useEffect(() => {
    loadPendingWithdrawals();
    loadOnchainData();
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  const loadPendingWithdrawals = async () => {
    try {
      const pending = await api.getPendingWithdrawals();
      setPendingWithdrawals(pending);
    } catch (err) {
      console.error('Failed to load pending withdrawals:', err);
    }
  };

  const loadOnchainData = async () => {
    try {
      const [deposits, pending] = await Promise.all([
        api.getOnchainDeposits(),
        api.getOnchainPendingWithdrawals(),
      ]);
      setOnchainDeposits(deposits);
      setOnchainPendingWithdrawals(pending);
    } catch (err) {
      console.error('Failed to load on-chain data:', err);
    }
  };

  // Lightning deposit handlers
  const handleDeposit = async () => {
    setDepositStatus('generating');
    setDepositError('');
    try {
      const inv = await api.createDeposit(depositAmount);
      setInvoice(inv);
      setDepositStatus('waiting');
      startPollingPayment(inv.payment_hash, inv.is_real);
    } catch (err) {
      setDepositError(err.message);
      setDepositStatus('error');
    }
  };

  const startPollingPayment = (paymentHash, isReal) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    const pollInterval = isReal ? 3000 : 2000;
    pollingRef.current = setInterval(async () => {
      try {
        setDepositStatus('checking');
        const result = await api.checkDeposit(paymentHash);
        if (result.status === 'credited' || result.status === 'already_credited' || result.status === 'paid') {
          clearInterval(pollingRef.current);
          setDepositStatus('credited');
          await onRefresh();
          setTimeout(onClose, 2000);
        } else {
          setDepositStatus('waiting');
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, pollInterval);
  };

  const handleSimulatePayment = async () => {
    try { await api.simulatePayment(invoice.payment_hash); } catch (err) { alert(err.message); }
  };

  const handleCancelDeposit = () => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    setInvoice(null);
    setDepositStatus('idle');
    setDepositError('');
  };

  // On-chain deposit handlers
  const handleOnchainDeposit = async () => {
    setOnchainDepositStatus('generating');
    setOnchainDepositError('');
    try {
      const result = await api.createOnchainDeposit();
      setOnchainAddress(result);
      setOnchainDepositStatus('ready');
    } catch (err) {
      setOnchainDepositError(err.message);
      setOnchainDepositStatus('idle');
    }
  };

  const handleCheckOnchainDeposit = async () => {
    setOnchainDepositStatus('checking');
    try {
      const result = await api.checkOnchainDeposit();
      setOnchainDeposits(result.deposits || []);
      if (result.credited && result.credited.length > 0) {
        await onRefresh();
        alert(`Deposit credited! +${formatSats(result.credited.reduce((s, c) => s + c.amount_sats, 0))} sats`);
      }
      setOnchainDepositStatus('ready');
    } catch (err) {
      setOnchainDepositError(err.message);
      setOnchainDepositStatus('ready');
    }
  };

  // Handle invoice change - parse and auto-update amount
  const handleInvoiceChange = (invoiceText) => {
    setWithdrawInvoice(invoiceText);
    setWithdrawError('');
    if (invoiceText) {
      const parsedAmount = decodeBolt11Amount(invoiceText);
      if (parsedAmount !== null) {
        setWithdrawAmount(String(parsedAmount));
      }
    }
  };

  // Lightning withdrawal handler
  const handleLightningWithdraw = async () => {
    if (!withdrawInvoice) {
      setWithdrawError('Please paste a Lightning invoice');
      return;
    }
    const invoiceAmount = decodeBolt11Amount(withdrawInvoice);
    const fieldAmount = parseInt(withdrawAmount) || 0;
    let actualAmount;
    if (invoiceAmount !== null) {
      actualAmount = invoiceAmount;
    } else if (fieldAmount >= 1000) {
      actualAmount = fieldAmount;
    } else {
      setWithdrawError('This invoice has no amount. Please enter an amount first (min 1,000 sats)');
      return;
    }
    if (actualAmount < 1000) {
      setWithdrawError('Minimum withdrawal is 1,000 sats');
      return;
    }
    setWithdrawStatus('processing');
    setWithdrawError('');
    setWithdrawResult(null);
    try {
      const result = await api.withdraw(withdrawInvoice, actualAmount);
      await onRefresh();
      if (result.status === 'completed') {
        setWithdrawStatus('completed');
        setWithdrawResult({ type: 'success', message: 'Withdrawal sent!', balance: result.balance_sats, botAdjustment: result.bot_adjustment });
      } else if (result.status === 'pending') {
        setWithdrawStatus('pending');
        setWithdrawResult({ type: 'pending', message: 'Withdrawal submitted for admin approval', reason: result.reason });
        loadPendingWithdrawals();
      }
      setWithdrawAmount('');
      setWithdrawInvoice('');
    } catch (err) {
      setWithdrawStatus('error');
      setWithdrawError(err.message);
    }
  };

  // On-chain withdrawal handler
  const handleOnchainWithdraw = async () => {
    const amount = parseInt(withdrawAmount) || 0;
    if (amount < 10000) {
      setWithdrawError('Minimum on-chain withdrawal is 10,000 sats');
      return;
    }
    if (!withdrawAddress) {
      setWithdrawError('Please enter a Bitcoin address');
      return;
    }
    setWithdrawStatus('processing');
    setWithdrawError('');
    setWithdrawResult(null);
    try {
      const result = await api.requestOnchainWithdrawal(withdrawAddress, amount);
      await onRefresh();
      setWithdrawStatus('pending');
      setWithdrawResult({ type: 'pending', message: 'On-chain withdrawal submitted for admin approval' });
      setWithdrawAmount('');
      setWithdrawAddress('');
      loadOnchainData();
    } catch (err) {
      setWithdrawStatus('error');
      setWithdrawError(err.message);
    }
  };

  const handleCancelWithdrawal = async (withdrawalId) => {
    if (!confirm('Cancel this pending withdrawal?')) return;
    setCancellingId(withdrawalId);
    try {
      await api.cancelWithdrawal(withdrawalId);
      await loadPendingWithdrawals();
      await onRefresh();
    } catch (err) { alert(err.message); }
    setCancellingId(null);
  };

  const handleCancelOnchainWithdrawal = async (withdrawalId) => {
    if (!confirm('Cancel this pending withdrawal?')) return;
    setCancellingId(withdrawalId);
    try {
      await api.cancelOnchainWithdrawal(withdrawalId);
      await loadOnchainData();
      await onRefresh();
    } catch (err) { alert(err.message); }
    setCancellingId(null);
  };

  const resetWithdrawState = () => {
    setWithdrawStatus('idle');
    setWithdrawResult(null);
    setWithdrawError('');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide wallet-modal" onClick={e => e.stopPropagation()}>
        <h2>💰 Wallet</h2>
        <div className="wallet-balance">
          <span>Balance:</span>
          <strong>{formatSats(user.balance_sats)} sats</strong>
        </div>

        {/* ========== DEPOSITS SECTION ========== */}
        <div className="wallet-section">
          <h3>📥 Deposit</h3>
          
          {/* LIGHTNING DEPOSIT */}
          <div className="deposit-method lightning-deposit">
            <h4>⚡ Lightning (Instant)</h4>
          {depositStatus === 'idle' || depositStatus === 'generating' || depositStatus === 'error' ? (
            <>
              {depositError && <div className="auth-error">{depositError}</div>}
              <div className="deposit-amount-input">
                <input
                  type="number"
                  value={depositAmount}
                  onChange={e => setDepositAmount(parseInt(e.target.value) || 0)}
                  min="1000"
                  step="1000"
                />
                <span className="sats-label">sats</span>
              </div>
              <div className="deposit-presets">
                <button className="btn btn-small btn-outline" onClick={() => setDepositAmount(10000)}>10k</button>
                <button className="btn btn-small btn-outline" onClick={() => setDepositAmount(50000)}>50k</button>
                <button className="btn btn-small btn-outline" onClick={() => setDepositAmount(100000)}>100k</button>
                <button className="btn btn-small btn-outline" onClick={() => setDepositAmount(500000)}>500k</button>
              </div>
              <button 
                className="btn btn-primary btn-large" 
                onClick={handleDeposit}
                disabled={depositStatus === 'generating' || depositAmount < 1000}
              >
                {depositStatus === 'generating' ? 'Generating Invoice...' : `Generate ${formatSats(depositAmount)} sats Invoice`}
              </button>
            </>
          ) : depositStatus === 'credited' ? (
            <div className="deposit-success">
              <div className="success-icon">✓</div>
              <p>Deposit credited!</p>
              <p className="success-amount">+{formatSats(depositAmount)} sats</p>
            </div>
          ) : (
            <div className="deposit-invoice">
              {invoice?.is_real && (
                <div className="real-invoice-badge">
                  ⚡ Real Lightning Invoice
                </div>
              )}
              
              <div className="invoice-qr-container">
                <QRCodeSVG 
                  value={invoice?.payment_request || ''}
                  size={200}
                  level="M"
                  includeMargin={true}
                  className="invoice-qr"
                />
              </div>

              <div className="invoice-amount">
                <strong>{formatSats(depositAmount)} sats</strong>
              </div>

              <div className="invoice-status">
                {depositStatus === 'waiting' && (
                  <>
                    <div className="pulse-dot"></div>
                    <span>Waiting for payment...</span>
                  </>
                )}
                {depositStatus === 'checking' && (
                  <>
                    <div className="spinner-small"></div>
                    <span>Checking payment status...</span>
                  </>
                )}
              </div>

              <div className="invoice-actions">
                <button className="btn btn-outline" onClick={() => {
                  if (invoice?.payment_request) {
                    navigator.clipboard.writeText(invoice.payment_request);
                    alert('Invoice copied!');
                  }
                }}>
                  📋 Copy Invoice
                </button>
                <a 
                  href={`lightning:${invoice?.payment_request}`} 
                  className="btn btn-primary"
                >
                  Open Wallet
                </a>
              </div>

              <div className="invoice-text">
                <code>{invoice?.payment_request?.slice(0, 50)}...</code>
              </div>

              {/* Show simulate button only for mock invoices */}
              {!invoice?.is_real && (
                <div className="test-mode-section">
                  <p className="test-mode-note">🧪 Test Mode - Mock Invoice</p>
                  <button className="btn btn-success" onClick={handleSimulatePayment}>
                    Simulate Payment
                  </button>
                </div>
              )}

              <button className="btn btn-outline btn-small" onClick={handleCancelDeposit}>
                Cancel
              </button>
            </div>
          )}
          </div>

          {/* ON-CHAIN DEPOSIT */}
          <div className="deposit-method onchain-deposit">
            <h4>₿ On-Chain (10+ min)</h4>
            <p className="method-note">Deposits ≤100k sats credit instantly. Larger need 1 confirmation.</p>
            
            {onchainDepositError && <div className="auth-error">{onchainDepositError}</div>}
            
            {onchainDepositStatus === 'idle' && (
              <button className="btn btn-outline" onClick={handleOnchainDeposit}>
                Generate Bitcoin Address
              </button>
            )}
            
            {onchainDepositStatus === 'generating' && (
              <div className="loading-state">
                <div className="spinner-small"></div>
                <span>Generating address...</span>
              </div>
            )}
            
            {(onchainDepositStatus === 'ready' || onchainDepositStatus === 'checking') && onchainAddress && (
              <div className="onchain-deposit-display">
                <div className="qr-wrapper qr-small">
                  <QRCodeSVG 
                    value={`bitcoin:${onchainAddress.address}`}
                    size={140}
                    level="M"
                    includeMargin={true}
                  />
                </div>
                <div className="address-display">
                  <code className="btc-address">{onchainAddress.address}</code>
                  <button 
                    className="btn btn-small btn-outline"
                    onClick={() => {
                      navigator.clipboard.writeText(onchainAddress.address);
                      alert('Address copied!');
                    }}
                  >
                    📋
                  </button>
                </div>
                <div className="onchain-actions">
                  <button 
                    className="btn btn-small btn-outline"
                    onClick={handleCheckOnchainDeposit}
                    disabled={onchainDepositStatus === 'checking'}
                  >
                    {onchainDepositStatus === 'checking' ? 'Checking...' : '🔄 Check'}
                  </button>
                  <button 
                    className="btn btn-small btn-outline"
                    onClick={handleOnchainDeposit}
                  >
                    New Address
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ========== WITHDRAWALS SECTION ========== */}
        <div className="wallet-section">
          <h3>💸 Withdraw</h3>
          
          {withdrawStatus === 'idle' || withdrawStatus === 'error' ? (
            <>
              {withdrawError && <div className="auth-error">{withdrawError}</div>}
              
              {/* SHARED AMOUNT */}
              <div className="withdraw-amount-section">
                <label>Amount to withdraw:</label>
                <div className="deposit-amount-input">
                  <input
                    type="number"
                    placeholder="Amount"
                    value={withdrawAmount}
                    onChange={e => setWithdrawAmount(e.target.value)}
                    min="1000"
                    step="1000"
                  />
                  <span className="sats-label">sats</span>
                </div>
                <div className="deposit-presets">
                  <button className="btn btn-small btn-outline" onClick={() => setWithdrawAmount('10000')}>10k</button>
                  <button className="btn btn-small btn-outline" onClick={() => setWithdrawAmount('50000')}>50k</button>
                  <button className="btn btn-small btn-outline" onClick={() => setWithdrawAmount('100000')}>100k</button>
                  <button className="btn btn-small btn-outline" onClick={() => setWithdrawAmount(String(user.balance_sats))}>Max</button>
                </div>
              </div>
              
              {/* WITHDRAWAL OPTIONS - SIDE BY SIDE */}
              <div className="withdraw-options">
                {/* LIGHTNING WITHDRAWAL */}
                <div className="withdraw-method">
                  <h4>⚡ Lightning</h4>
                  <p className="method-note">Min 1k sats. ≤100k instant if within deposits.</p>
                  <input
                    type="text"
                    placeholder="Paste Lightning invoice (lnbc...)"
                    value={withdrawInvoice}
                    onChange={e => handleInvoiceChange(e.target.value)}
                    className="withdraw-input"
                  />
                  <button 
                    className="btn btn-primary" 
                    onClick={handleLightningWithdraw}
                    disabled={!withdrawInvoice}
                  >
                    ⚡ Withdraw via Lightning
                  </button>
                </div>
                
                {/* ON-CHAIN WITHDRAWAL */}
                <div className="withdraw-method">
                  <h4>₿ On-Chain</h4>
                  <p className="method-note">Min 10k sats. All require admin approval.</p>
                  <input
                    type="text"
                    placeholder="Bitcoin address (bc1..., 3..., 1...)"
                    value={withdrawAddress}
                    onChange={e => setWithdrawAddress(e.target.value)}
                    className="withdraw-input"
                  />
                  <button 
                    className="btn btn-outline" 
                    onClick={handleOnchainWithdraw}
                    disabled={!withdrawAddress || (parseInt(withdrawAmount) || 0) < 10000}
                  >
                    ₿ Withdraw On-Chain
                  </button>
                </div>
              </div>
            </>
          ) : withdrawStatus === 'processing' ? (
            <div className="withdraw-processing">
              <div className="spinner"></div>
              <p>Processing withdrawal...</p>
            </div>
          ) : withdrawStatus === 'completed' && withdrawResult ? (
            <div className="withdraw-success">
              <div className="success-icon">✓</div>
              <p>{withdrawResult.message}</p>
              <p className="success-amount">New balance: {formatSats(withdrawResult.balance)} sats</p>
              {withdrawResult.botAdjustment && (
                <div className="bot-adjustment-notice">
                  ⚠️ {withdrawResult.botAdjustment.message}
                </div>
              )}
              <button className="btn btn-outline" onClick={resetWithdrawState}>
                Make Another Withdrawal
              </button>
            </div>
          ) : withdrawStatus === 'pending' && withdrawResult ? (
            <div className="withdraw-pending">
              <div className="pending-icon">⏳</div>
              <p>{withdrawResult.message}</p>
              <p className="pending-reason">{withdrawResult.reason}</p>
              <p className="pending-note">
                Your funds are held until the withdrawal is processed.<br/>
                You can cancel this withdrawal below to get your funds back.
              </p>
              <button className="btn btn-outline" onClick={resetWithdrawState}>
                Make Another Withdrawal
              </button>
            </div>
          ) : null}

          {/* Pending Withdrawals List */}
          {(pendingWithdrawals.length > 0 || onchainPendingWithdrawals.length > 0) && (
            <div className="pending-withdrawals-list">
              <h4>Pending Withdrawals</h4>
              {pendingWithdrawals.map(pw => (
                <div key={`ln-${pw.id}`} className="pending-withdrawal-item">
                  <div className="pw-info">
                    <span className="pw-type">⚡</span>
                    <span className="pw-amount">{formatSats(pw.amount_sats)} sats</span>
                    <span className="pw-date">{new Date(pw.created_at).toLocaleString()}</span>
                  </div>
                  <button 
                    className="btn btn-small btn-danger"
                    onClick={() => handleCancelWithdrawal(pw.id)}
                    disabled={cancellingId === pw.id}
                  >
                    {cancellingId === pw.id ? 'Cancelling...' : 'Cancel'}
                  </button>
                </div>
              ))}
              {onchainPendingWithdrawals.map(pw => (
                <div key={`oc-${pw.id}`} className="pending-withdrawal-item">
                  <div className="pw-info">
                    <span className="pw-type">₿</span>
                    <span className="pw-amount">{formatSats(pw.amount_sats)} sats</span>
                    <span className="pw-address" title={pw.dest_address}>{pw.dest_address?.slice(0,8)}...</span>
                  </div>
                  <button 
                    className="btn btn-small btn-danger"
                    onClick={() => handleCancelOnchainWithdrawal(pw.id)}
                    disabled={cancellingId === pw.id}
                  >
                    {cancellingId === pw.id ? 'Cancelling...' : 'Cancel'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button className="btn btn-outline modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function EventMarket({ market, user, onLogin, onRefresh }) {
  const [side, setSide] = useState('yes');
  const [price, setPrice] = useState(50);
  const [shares, setShares] = useState(10);
  const [loading, setLoading] = useState(false);

  if (!market) return null;

  // Convert percentage (1-99) to sats/share (10-990)
  const priceSats = price * 10;
  const totalPayout = shares * SATS_PER_SHARE;
  const cost = side === 'yes' 
    ? Math.ceil(totalPayout * priceSats / 1000)
    : Math.ceil(totalPayout * (1000 - priceSats) / 1000);

  const handleTrade = async () => {
    if (!user) {
      onLogin();
      return;
    }
    setLoading(true);
    try {
      // Pass priceSats (500) not price (50) - backend expects sats/share
      await api.placeOrder(market.id, side, priceSats, totalPayout);
      await onRefresh();
      alert(`Order placed! Cost: ${formatSats(cost)} sats`);
    } catch (err) {
      alert(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="event-market">
      <div className="event-market-header">
        <h2>🏆 {market.title}</h2>
        <span className={`status status-${market.status}`}>{market.status}</span>
      </div>
      <p className="event-description">{market.description}</p>
      
      {market.status === 'open' && (
        <div className="trade-panel">
          <div className="trade-sides">
            <button 
              className={`side-btn side-yes ${side === 'yes' ? 'active' : ''}`}
              onClick={() => setSide('yes')}
            >
              YES
            </button>
            <button 
              className={`side-btn side-no ${side === 'no' ? 'active' : ''}`}
              onClick={() => setSide('no')}
            >
              NO
            </button>
          </div>
          
          <div className="trade-inputs">
            <label>
              Probability
              <input
                type="range"
                min="1"
                max="99"
                value={price}
                onChange={e => setPrice(parseInt(e.target.value))}
              />
              <span className="price-display">{price}%</span>
            </label>
            
            <label>
              Shares (each pays {formatSats(SATS_PER_SHARE)} sats if correct)
              <input
                type="number"
                value={shares}
                onChange={e => setShares(parseInt(e.target.value) || 0)}
                min="1"
                step="1"
              />
            </label>
          </div>
          
          <div className="trade-summary">
            <span>Cost: <strong>{formatSats(cost)} sats</strong></span>
            <span>Payout if correct: <strong>{formatSats(totalPayout)} sats</strong></span>
          </div>
          
          <button 
            className={`btn btn-large ${side === 'yes' ? 'btn-yes' : 'btn-no'}`}
            onClick={handleTrade}
            disabled={loading}
          >
            {loading ? 'Placing...' : `Buy ${shares} ${side.toUpperCase()} @ ${price}%`}
          </button>
        </div>
      )}

      {market.orderBook && (
        <div className="order-book-mini">
          <div className="ob-side ob-yes">
            <h4>YES Orders</h4>
            {market.orderBook.yes.slice(0, 5).map((o, i) => (
              <div key={i} className="ob-row">
                <span>{o.price_sats}%</span>
                <span>{formatSats(o.total_sats)} sats</span>
              </div>
            ))}
            {market.orderBook.yes.length === 0 && <span className="empty">No orders</span>}
          </div>
          <div className="ob-side ob-no">
            <h4>NO Orders</h4>
            {market.orderBook.no.slice(0, 5).map((o, i) => (
              <div key={i} className="ob-row">
                <span>{o.price_sats}%</span>
                <span>{formatSats(o.total_sats)} sats</span>
              </div>
            ))}
            {market.orderBook.no.length === 0 && <span className="empty">No orders</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function ParticipantBrowser({ grandmasters, onSelectGM }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('odds'); // 'odds' or 'rating'
  const [priceView, setPriceView] = useState('yes'); // 'yes' or 'no'

  const filtered = grandmasters
    .filter(gm => gm.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'odds') {
        const aOdds = a.attendance_yes_price || 0;
        const bOdds = b.attendance_yes_price || 0;
        // If viewing NO prices, we want lowest YES (highest NO) first
        if (priceView === 'no') {
          return aOdds - bOdds; // Lower YES = Higher NO first
        }
        return bOdds - aOdds; // Higher YES first
      }
      return b.fide_rating - a.fide_rating; // Higher rating first
    });

  // Calculate display price based on view mode
  const getDisplayPrice = (gm) => {
    if (!gm.attendance_yes_price) return null;
    if (priceView === 'yes') return gm.attendance_yes_price;
    return 100 - gm.attendance_yes_price; // NO price is complement
  };

  return (
    <div className="gm-browser">
      <div className="gm-browser-header">
        <h2>♟️ Who Will Participate</h2>
      </div>
      
      <div className="gm-controls">
        <input
          type="text"
          placeholder="Search participant..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="gm-search"
        />
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="odds">Sort by Odds</option>
          <option value="rating">Sort by Rating</option>
        </select>
        <div className="price-view-toggle">
          <button 
            className={`price-toggle-btn ${priceView === 'yes' ? 'active' : ''}`}
            onClick={() => setPriceView('yes')}
            title="Show YES price (probability they attend)"
          >
            YES
          </button>
          <button 
            className={`price-toggle-btn ${priceView === 'no' ? 'active' : ''}`}
            onClick={() => setPriceView('no')}
            title="Show NO price (probability they don't attend)"
          >
            NO
          </button>
        </div>
      </div>
      
      <div className="gm-list">
        {filtered.map(gm => {
          const displayPrice = getDisplayPrice(gm);
          return (
            <div 
              key={gm.id} 
              className="gm-card"
              onClick={() => onSelectGM(gm, 'attendance')}
            >
              <div className="gm-info">
                <span className="gm-name">{gm.name}</span>
                <span className="gm-details">{gm.country} • {gm.fide_rating}</span>
              </div>
              <div className="gm-odds">
                {displayPrice !== null ? (
                  <span className={`odds-badge odds-${priceView}`}>
                    <span className="odds-label">{priceView.toUpperCase()}</span>
                    <span className="odds-value">{displayPrice}%</span>
                  </span>
                ) : (
                  <span className="odds-badge empty">--</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WhatsThePoint({ onClose }) {
  return (
    <div className="whats-the-point">
      <button className="btn btn-outline back-btn" onClick={onClose}>← Back to Markets</button>
      
      <h2>🎯 What's the Point?</h2>
      
      <div className="point-section">
        <h3>💡 This Prediction Market Creates Real Incentives</h3>
        <p>
          Unlike traditional betting, this prediction market serves a unique purpose: <strong>helping make the Bitcoin Chess 960 Championship actually happen</strong> by creating financial incentives for participants.
        </p>
      </div>

      <div className="point-section">
        <h3>♟️ For Chess Players</h3>
        <p>
          If you're a grandmaster or strong player considering attending, you can <strong>bet YES on yourself</strong>. Here's why this matters:
        </p>
        <ul>
          <li><strong>Show your commitment</strong> — A YES bet signals you're serious about attending</li>
          <li><strong>Get paid for showing up</strong> — If you bet YES on attending and you do attend, you win your bet!</li>
          <li><strong>Low-risk for participants</strong> — You control whether you attend, so a YES bet on yourself is essentially a commitment bonus</li>
        </ul>
        <div className="example-box">
          <strong>Example:</strong> Magnus bets 100,000 sats that he'll attend at 70% odds. If he shows up, he wins ~43,000 sats profit. It's like getting paid to attend!
        </div>
      </div>

      <div className="point-section">
        <h3>🏦 For Event Organizers</h3>
        <p>
          The organizers provide liquidity on the <strong>NO side</strong> of attendance markets. This means:
        </p>
        <ul>
          <li><strong>If a player attends</strong> — Organizers pay out the YES bettors, but they've successfully recruited a participant</li>
          <li><strong>If a player doesn't attend</strong> — Organizers keep the stakes from YES bettors</li>
          <li><strong>Either way, the market generates buzz</strong> — People tracking odds = free marketing</li>
        </ul>
      </div>

      <div className="point-section">
        <h3>📊 For Spectators & Fans</h3>
        <p>
          Even if you're not playing, you can:
        </p>
        <ul>
          <li><strong>Bet on who will attend</strong> — Think a top player will come? Put sats on it!</li>
          <li><strong>Bet on who will win</strong> — Show your chess knowledge by predicting the champion</li>
          <li><strong>Track the action</strong> — Market odds give real-time insight into who's likely coming</li>
        </ul>
      </div>

      <div className="point-section">
        <h3>⚡ Why Bitcoin?</h3>
        <p>
          All trades happen in <strong>satoshis</strong> (the smallest unit of Bitcoin) via the <strong>Lightning Network</strong>:
        </p>
        <ul>
          <li><strong>Instant settlements</strong> — No waiting days for payouts</li>
          <li><strong>Global access</strong> — Anyone in the world can participate</li>
          <li><strong>Low fees</strong> — Lightning makes micropayments practical</li>
          <li><strong>Self-custody</strong> — Your keys, your coins</li>
        </ul>
      </div>

      <div className="point-section highlight">
        <h3>🤝 The Win-Win</h3>
        <p>
          This market is a <strong>coordination mechanism</strong>. This prediction market:
        </p>
        <ul>
          <li>Gives players a financial reason to commit early</li>
          <li>Gives organizers a recruitment tool that pays for itself</li>
          <li>Gives fans a stake in the outcome and a reason to follow along</li>
          <li>Creates transparent, real-time signals about who's likely to participate</li>
        </ul>
        <p className="tldr">
          <strong>TL;DR:</strong> Bet YES on yourself if you're coming. Bet on your favorite players if you're watching. Everyone wins when the event succeeds! 🏆
        </p>
      </div>

      <button className="btn btn-primary btn-large" onClick={onClose}>
        Got it — Let's Trade! ⚡
      </button>
    </div>
  );
}

function WinnerBrowser({ grandmasters, onSelectGM }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('odds'); // 'odds' or 'rating'

  const filtered = grandmasters
    .filter(gm => gm.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'odds') {
        const aOdds = a.winner_yes_price || 0;
        const bOdds = b.winner_yes_price || 0;
        return bOdds - aOdds; // Higher odds first
      }
      return b.fide_rating - a.fide_rating; // Higher rating first
    });

  return (
    <div className="gm-browser winner-browser">
      <div className="gm-browser-header">
        <h2>🏆 Who Will Win</h2>
      </div>
      
      <div className="gm-controls">
        <input
          type="text"
          placeholder="Search participant..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="gm-search"
        />
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
          <option value="odds">Sort by Odds</option>
          <option value="rating">Sort by Rating</option>
        </select>
      </div>
      
      <div className="gm-list">
        {filtered.map(gm => (
          <div 
            key={gm.id} 
            className="gm-card"
            onClick={() => onSelectGM(gm, 'winner')}
          >
            <div className="gm-info">
              <span className="gm-name">{gm.name}</span>
              <span className="gm-details">{gm.country} • {gm.fide_rating}</span>
            </div>
            <div className="gm-odds">
              {gm.winner_yes_price ? (
                <span className="odds-badge odds-win">{gm.winner_yes_price}%</span>
              ) : (
                <span className="odds-badge empty">--</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarketDetail({ market, user, onBack, onLogin, onRefresh }) {
  const [side, setSide] = useState('yes');
  const [price, setPrice] = useState(50);
  const [shares, setShares] = useState(10);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  // Handle clicking on an order book offer to fill in the trade form
  const handleOfferClick = (offerSide, priceSats, availableShares) => {
    const newSide = offerSide === 'yes' ? 'no' : 'yes';
    // Take the opposite side of the offer
    setSide(newSide);
    // Use the same price (probability)
    setPrice(priceSats);
    // Set shares to match what's available
    setShares(availableShares);
    
    // Show toast notification
    const costPerShare = newSide === 'yes' ? priceSats : (1000 - priceSats);
    const totalCost = Math.ceil(availableShares * SATS_PER_SHARE * costPerShare / 1000);
    setToast({
      message: `✓ Form filled: ${availableShares} ${newSide.toUpperCase()} @ ${priceSats}%`,
      subtext: `Cost: ${formatSats(totalCost)} sats — Click "Buy" to confirm!`
    });
    
    // Auto-hide toast after 4 seconds
    setTimeout(() => setToast(null), 4000);
  };

  if (!market) return null;

  // Convert percentage (1-99) to sats/share (10-990)
  // 50% = 500 sats/share, since 1 share pays out 1000 sats
  const priceSats = price * 10;
  const totalPayout = shares * SATS_PER_SHARE;
  const cost = side === 'yes' 
    ? Math.ceil(totalPayout * priceSats / 1000)
    : Math.ceil(totalPayout * (1000 - priceSats) / 1000);
  const profit = totalPayout - cost;
  const profitPercent = cost > 0 ? Math.round((profit / cost) * 100) : 0;

  const handleTrade = async () => {
    if (!user) {
      onLogin();
      return;
    }
    setLoading(true);
    try {
      // Pass priceSats (500) not price (50) - backend expects sats/share
      await api.placeOrder(market.id, side, priceSats, totalPayout);
      await onRefresh();
    } catch (err) {
      alert(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="market-detail">
      <button className="btn btn-outline back-btn" onClick={onBack}>← Back</button>
      
      <div className="market-header">
        <h2>{market.title}</h2>
        {market.grandmaster_name && (
          <div className="gm-badge">
            {market.grandmaster_name} • {market.country} • {market.fide_rating}
          </div>
        )}
        <span className={`status status-${market.status}`}>{market.status}</span>
      </div>
      
      <p className="market-description">{market.description}</p>

      {/* Share Model Explainer */}
      <div className="share-explainer">
        <strong>💡 How shares work:</strong> Each share pays out <strong>{formatSats(SATS_PER_SHARE)} sats</strong> if your prediction is correct. 
        Buying at lower probability = higher potential profit!
      </div>

      <div className="market-content">
        {market.status === 'open' && (
          <div className="trade-panel">
            <div className="trade-sides">
              <button 
                className={`side-btn side-yes ${side === 'yes' ? 'active' : ''}`}
                onClick={() => setSide('yes')}
              >
                YES
              </button>
              <button 
                className={`side-btn side-no ${side === 'no' ? 'active' : ''}`}
                onClick={() => setSide('no')}
              >
                NO
              </button>
            </div>
            
            <div className="trade-inputs">
              <label>
                Your probability estimate
                <input
                  type="range"
                  min="1"
                  max="99"
                  value={price}
                  onChange={e => setPrice(parseInt(e.target.value))}
                />
                <span className="price-display">{price}%</span>
              </label>
              
              <label>
                Number of shares
                <input
                  type="number"
                  value={shares}
                  onChange={e => setShares(parseInt(e.target.value) || 0)}
                  min="1"
                  step="1"
                />
              </label>
            </div>
            
            <div className="trade-summary-detailed">
              <div className="summary-row">
                <span>You pay:</span>
                <span className="summary-value cost">
                  {side === 'yes' ? priceSats : (1000 - priceSats)} sats/share × {shares} = <strong>{formatSats(cost)} sats</strong>
                </span>
              </div>
              <div className="summary-row">
                <span>If {side.toUpperCase()} wins:</span>
                <span className="summary-value payout">
                  {formatSats(SATS_PER_SHARE)} sats/share × {shares} = <strong>{formatSats(totalPayout)} sats</strong>
                </span>
              </div>
              <div className="summary-row profit-row">
                <span>Profit if correct:</span>
                <span className="summary-value profit">
                  <strong>+{formatSats(profit)} sats</strong> <span className="profit-percent">(+{profitPercent}%)</span>
                </span>
              </div>
            </div>
            
            <button 
              className={`btn btn-large ${side === 'yes' ? 'btn-yes' : 'btn-no'}`}
              onClick={handleTrade}
              disabled={loading || shares < 1}
            >
              {loading ? 'Placing...' : `Buy ${shares} ${side.toUpperCase()} share${shares !== 1 ? 's' : ''} @ ${price}%`}
            </button>
          </div>
        )}

        {/* Toast notification */}
        {toast && (
          <div className="trade-toast">
            <div className="toast-message">{toast.message}</div>
            <div className="toast-subtext">{toast.subtext}</div>
          </div>
        )}

        <div className="order-book">
          <h3>Order Book</h3>
          <p className="ob-hint">
            👆 <strong>Click any offer to auto-fill your trade</strong> — you'll take the opposite side at that price. 
            Then just hit "Buy" to complete the trade instantly!
          </p>
          <div className="ob-container">
            <div className="ob-side ob-yes">
              <h4>YES Offers</h4>
              <div className="ob-header-row">
                <span>Price</span>
                <span>Shares</span>
                <span>Total</span>
              </div>
              {market.orderBook?.yes.map((o, i) => {
                const shares = satsToShares(o.total_sats);
                const priceSats = o.price_sats * 10; // 40% = 400 sats/share
                const totalCost = shares * priceSats;
                return (
                  <div 
                    key={i} 
                    className="ob-row ob-row-clickable"
                    onClick={() => handleOfferClick('yes', o.price_sats, shares)}
                    title={`Click to buy ${shares} NO shares at ${100 - o.price_sats}%`}
                  >
                    <span className="ob-price">{formatSats(priceSats)}</span>
                    <span className="ob-shares">{shares}</span>
                    <span className="ob-total">{formatSats(totalCost)}</span>
                    <div className="ob-bar" style={{ width: `${Math.min(shares * 5, 100)}%` }} />
                  </div>
                );
              })}
              {(!market.orderBook?.yes || market.orderBook.yes.length === 0) && (
                <span className="empty">No offers</span>
              )}
              {market.orderBook?.yes && market.orderBook.yes.length > 0 && (
                <div className="ob-depth">
                  Depth: {market.orderBook.yes.reduce((sum, o) => sum + satsToShares(o.total_sats), 0)} shares
                </div>
              )}
            </div>
            <div className="ob-side ob-no">
              <h4>NO Offers</h4>
              <div className="ob-header-row">
                <span>Price</span>
                <span>Shares</span>
                <span>Total</span>
              </div>
              {market.orderBook?.no.map((o, i) => {
                const shares = satsToShares(o.total_sats);
                const priceSats = (100 - o.price_sats) * 10; // NO price = 100 - YES price
                const totalCost = shares * priceSats;
                return (
                  <div 
                    key={i} 
                    className="ob-row ob-row-clickable"
                    onClick={() => handleOfferClick('no', o.price_sats, shares)}
                    title={`Click to buy ${shares} YES shares at ${o.price_sats}%`}
                  >
                    <span className="ob-price">{formatSats(priceSats)}</span>
                    <span className="ob-shares">{shares}</span>
                    <span className="ob-total">{formatSats(totalCost)}</span>
                    <div className="ob-bar ob-bar-no" style={{ width: `${Math.min(shares * 5, 100)}%` }} />
                  </div>
                );
              })}
              {(!market.orderBook?.no || market.orderBook.no.length === 0) && (
                <span className="empty">No offers</span>
              )}
              {market.orderBook?.no && market.orderBook.no.length > 0 && (
                <div className="ob-depth">
                  Depth: {market.orderBook.no.reduce((sum, o) => sum + satsToShares(o.total_sats), 0)} shares
                </div>
              )}
            </div>
          </div>
        </div>

        {market.recentTrades && market.recentTrades.length > 0 && (
          <div className="recent-trades">
            <h3>Recent Trades</h3>
            {market.recentTrades.map((t, i) => (
              <div key={i} className="trade-row">
                <span className="trade-price">{formatSats(t.price_sats * 10)} sats/share</span>
                <span className="trade-shares">{satsToShares(t.amount_sats)} share{satsToShares(t.amount_sats) !== 1 ? 's' : ''}</span>
                <span className="trade-time">{new Date(t.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PortfolioModal({ user, onClose, onRefresh, onSelectMarket }) {
  const [activeTab, setActiveTab] = useState('positions');
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [txFilter, setTxFilter] = useState('');
  const [cancelling, setCancelling] = useState(null);

  useEffect(() => {
    loadPortfolioData();
  }, []);

  const loadPortfolioData = async () => {
    setLoading(true);
    try {
      const [posData, ordData, txData, tradeData] = await Promise.all([
        api.getNetPositions(), // Use aggregated net positions
        api.getOpenOrders(),
        api.getTransactions({ limit: 50 }),
        api.getTrades({ limit: 50 }),
      ]);
      setPositions(posData);
      setOrders(ordData);
      setTransactions(txData.transactions);
      setTrades(tradeData.trades);
    } catch (err) {
      console.error('Failed to load portfolio:', err);
    }
    setLoading(false);
  };

  const handleCancelOrder = async (orderId) => {
    if (!confirm('Are you sure you want to cancel this order?')) return;
    setCancelling(orderId);
    try {
      await api.cancelOrder(orderId);
      await loadPortfolioData();
      await onRefresh();
    } catch (err) {
      alert(err.message);
    }
    setCancelling(null);
  };

  const handleCancelAllOrders = async () => {
    if (orders.length === 0) {
      alert('No open orders to cancel');
      return;
    }
    if (!confirm(`Are you sure you want to cancel ALL ${orders.length} open orders?`)) return;
    setCancelling('all');
    try {
      const result = await api.cancelAllOrders();
      alert(`Cancelled ${result.ordersCancelled} orders. Refunded ${formatSats(result.refund)} sats.`);
      await loadPortfolioData();
      await onRefresh();
    } catch (err) {
      alert(err.message);
    }
    setCancelling(null);
  };

  const filteredTransactions = txFilter 
    ? transactions.filter(t => t.type === txFilter)
    : transactions;

  // Calculate total value of positions (potential payout)
  const totalPositionValue = positions.reduce((sum, p) => sum + p.potential_payout, 0);
  const totalCostBasis = positions.reduce((sum, p) => sum + p.total_cost_sats, 0);
  const totalShares = positions.reduce((sum, p) => sum + p.shares, 0);
  const totalOrdersLocked = orders.reduce((sum, o) => {
    const remaining = o.amount_sats - o.filled_sats;
    return sum + (o.side === 'yes' 
      ? Math.ceil(remaining * o.price_sats / 1000)
      : Math.ceil(remaining * (1000 - o.price_sats) / 1000));
  }, 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-fullscreen" onClick={e => e.stopPropagation()}>
        <h2>📊 Portfolio</h2>
        
        <div className="portfolio-summary">
          <div className="summary-item">
            <span className="summary-label">Available Balance</span>
            <span className="summary-value">{formatSats(user.balance_sats)} sats</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">In Open Orders</span>
            <span className="summary-value">{formatSats(totalOrdersLocked)} sats</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">Total Shares Held</span>
            <span className="summary-value">{totalShares} shares</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">Potential Payout</span>
            <span className="summary-value">{formatSats(totalPositionValue)} sats</span>
          </div>
        </div>

        <div className="portfolio-tabs">
          <button 
            className={activeTab === 'positions' ? 'active' : ''} 
            onClick={() => setActiveTab('positions')}
          >
            Positions ({positions.length})
          </button>
          <button 
            className={activeTab === 'orders' ? 'active' : ''} 
            onClick={() => setActiveTab('orders')}
          >
            Open Orders ({orders.length})
          </button>
          <button 
            className={activeTab === 'trades' ? 'active' : ''} 
            onClick={() => setActiveTab('trades')}
          >
            Trade History
          </button>
          <button 
            className={activeTab === 'transactions' ? 'active' : ''} 
            onClick={() => setActiveTab('transactions')}
          >
            Transactions
          </button>
        </div>

        {loading ? (
          <div className="portfolio-loading">Loading...</div>
        ) : (
          <div className="portfolio-content">
            {/* POSITIONS TAB - Shows aggregated net positions per market */}
            {activeTab === 'positions' && (
              <div className="portfolio-positions">
                {positions.length === 0 ? (
                  <div className="empty-state">
                    <p>No active positions</p>
                    <p className="empty-hint">Place trades on markets to see your positions here.</p>
                  </div>
                ) : (
                  <>
                    <p className="positions-hint">
                      💡 Each share pays <strong>1,000 sats</strong> if your prediction is correct.
                    </p>
                    <table className="portfolio-table">
                      <thead>
                        <tr>
                          <th>Market</th>
                          <th>Position</th>
                          <th>Cost</th>
                          <th>Potential Profit</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map(p => {
                          // Determine display status and result
                          const isWin = p.market_status === 'closed' && p.result === 'won';
                          const isLoss = p.market_status === 'closed' && p.result === 'lost';
                          const isPending = p.market_status === 'pending_resolution';
                          const displayStatus = isWin ? 'Won' : isLoss ? 'Lost' : isPending ? 'Pending' : 'Ongoing';
                          const statusClass = isWin ? 'status-won' : isLoss ? 'status-lost' : isPending ? 'status-pending' : 'status-ongoing';
                          
                          // Format market name - shorter version
                          const marketName = p.grandmaster_name 
                            ? `${p.grandmaster_name} Attends`
                            : p.market_title;
                          
                          // Calculate profit
                          const profit = p.potential_payout - p.total_cost_sats;
                          
                          return (
                            <tr key={p.market_id} className={statusClass}>
                              <td className="market-cell">
                                <a 
                                  className="market-link" 
                                  onClick={() => onSelectMarket && onSelectMarket(p.market_id)}
                                >
                                  {marketName}
                                </a>
                              </td>
                              <td>
                                <span className={`position-badge side-${p.net_side}`}>
                                  {p.shares} {p.net_side?.toUpperCase()}
                                </span>
                              </td>
                              <td className="cost-cell">{formatSats(p.total_cost_sats)} sats</td>
                              <td className="profit-cell">
                                <span className={profit > 0 ? 'profit-positive' : 'profit-zero'}>
                                  {profit > 0 ? '+' : ''}{formatSats(profit)} sats
                                </span>
                              </td>
                              <td>
                                <span className={`status-badge ${statusClass}`}>
                                  {displayStatus}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            )}

            {/* OPEN ORDERS TAB */}
            {activeTab === 'orders' && (
              <div className="portfolio-orders">
                {orders.length > 0 && (
                  <div className="orders-actions">
                    <button 
                      className="btn btn-danger"
                      onClick={handleCancelAllOrders}
                      disabled={cancelling === 'all'}
                    >
                      {cancelling === 'all' ? 'Cancelling All...' : `Cancel All Orders (${orders.length})`}
                    </button>
                  </div>
                )}
                {orders.length === 0 ? (
                  <div className="empty-state">
                    <p>No open orders</p>
                    <p className="empty-hint">Your limit orders waiting to be filled will appear here.</p>
                  </div>
                ) : (
                  <table className="portfolio-table">
                    <thead>
                      <tr>
                        <th>Market</th>
                        <th>Side</th>
                        <th>Price</th>
                        <th>Amount</th>
                        <th>Filled</th>
                        <th>Created</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map(o => (
                        <tr key={o.id}>
                          <td className="market-cell">
                            <a 
                              className="market-link" 
                              onClick={() => onSelectMarket && onSelectMarket(o.market_id)}
                            >
                              {o.grandmaster_name ? `${o.grandmaster_name}: ` : ''}{o.title}
                            </a>
                          </td>
                          <td>
                            <span className={`side-badge side-${o.side}`}>
                              {o.side.toUpperCase()}
                            </span>
                          </td>
                          <td>{o.price_sats}%</td>
                          <td>{formatSats(o.amount_sats)} sats</td>
                          <td>
                            {formatSats(o.filled_sats)} / {formatSats(o.amount_sats)}
                            <div className="fill-bar">
                              <div 
                                className="fill-progress" 
                                style={{ width: `${(o.filled_sats / o.amount_sats) * 100}%` }}
                              />
                            </div>
                          </td>
                          <td className="date-cell">
                            {new Date(o.created_at).toLocaleDateString()}
                          </td>
                          <td>
                            <button 
                              className="btn btn-small btn-danger"
                              onClick={() => handleCancelOrder(o.id)}
                              disabled={cancelling === o.id}
                            >
                              {cancelling === o.id ? 'Cancelling...' : 'Cancel'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* TRADE HISTORY TAB */}
            {activeTab === 'trades' && (
              <div className="portfolio-trades">
                {trades.length === 0 ? (
                  <div className="empty-state">
                    <p>No trade history</p>
                    <p className="empty-hint">Your matched trades will appear here.</p>
                  </div>
                ) : (
                  <table className="portfolio-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Market</th>
                        <th>Side</th>
                        <th>Price</th>
                        <th>Amount</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map(t => {
                        // Calculate actual price in sats/share based on side
                        const priceSatsPerShare = t.user_side === 'yes' 
                          ? t.price_sats * 10 
                          : (100 - t.price_sats) * 10;
                        return (
                          <tr key={t.id} className={t.result !== 'pending' ? `trade-${t.result}` : ''}>
                            <td className="date-cell">
                              {new Date(t.created_at).toLocaleDateString()}
                            </td>
                            <td className="market-cell">
                              <a 
                                className="market-link" 
                                onClick={() => onSelectMarket && onSelectMarket(t.market_id)}
                              >
                                {t.grandmaster_name ? `${t.grandmaster_name}: ` : ''}{t.market_title}
                              </a>
                            </td>
                            <td>
                              <span className={`side-badge side-${t.user_side}`}>
                                {t.user_side.toUpperCase()}
                              </span>
                            </td>
                            <td>{formatSats(priceSatsPerShare)} sats</td>
                            <td>{formatSats(t.amount_sats)} sats</td>
                            <td>
                              <span className={`result-badge result-${t.result}`}>
                                {t.result === 'won' && '✓ Won'}
                                {t.result === 'lost' && '✗ Lost'}
                                {t.result === 'pending' && '⏳ Pending'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* TRANSACTIONS TAB */}
            {activeTab === 'transactions' && (
              <div className="portfolio-transactions">
                <div className="tx-filters">
                  <select value={txFilter} onChange={e => setTxFilter(e.target.value)}>
                    <option value="">All Transactions</option>
                    <option value="deposit">Deposits</option>
                    <option value="withdrawal">Withdrawals</option>
                    <option value="order_placed">Orders Placed</option>
                    <option value="order_cancelled">Orders Cancelled</option>
                    <option value="bet_won">Bets Won</option>
                  </select>
                </div>
                
                {filteredTransactions.length === 0 ? (
                  <div className="empty-state">
                    <p>No transactions found</p>
                  </div>
                ) : (
                  <table className="portfolio-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>Balance After</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTransactions.map(t => (
                        <tr key={t.id} className={t.amount_sats >= 0 ? 'tx-positive' : 'tx-negative'}>
                          <td className="date-cell">
                            {new Date(t.created_at).toLocaleString()}
                          </td>
                          <td>
                            <span className={`tx-type tx-${t.type}`}>
                              {t.type === 'deposit' && '⬇️ Deposit'}
                              {t.type === 'withdrawal' && '⬆️ Withdrawal'}
                              {t.type === 'order_placed' && '📝 Order'}
                              {t.type === 'order_cancelled' && '↩️ Refund'}
                              {t.type === 'bet_won' && '🏆 Won'}
                            </span>
                          </td>
                          <td className={t.amount_sats >= 0 ? 'amount-positive' : 'amount-negative'}>
                            {t.amount_sats >= 0 ? '+' : ''}{formatSats(t.amount_sats)} sats
                          </td>
                          <td>{formatSats(t.balance_after)} sats</td>
                          <td className="details-cell">
                            {t.market_title || t.lightning_invoice?.slice(0, 20) + '...' || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        <button className="btn btn-outline modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// Profile Modal with account management
function ProfileModal({ user, onClose, onUserUpdate }) {
  const [activeTab, setActiveTab] = useState('info');
  const [username, setUsername] = useState(user.username || '');
  const [email, setEmail] = useState(user.email || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showLinkLightning, setShowLinkLightning] = useState(false);

  const handleSaveProfile = async () => {
    setError('');
    setSuccess('');
    setLoading(true);
    
    try {
      const updates = {};
      if (username !== user.username) updates.username = username;
      if (email !== user.email) updates.email = email || null;
      
      if (Object.keys(updates).length === 0) {
        setError('No changes to save');
        setLoading(false);
        return;
      }
      
      const updatedUser = await api.updateProfile(updates);
      onUserUpdate(updatedUser);
      setSuccess('Profile updated successfully!');
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const handleChangePassword = async () => {
    setError('');
    setSuccess('');
    
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    
    setLoading(true);
    try {
      await api.changePassword(currentPassword || null, newPassword);
      setSuccess('Password updated successfully!');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const handleUnlinkLightning = async () => {
    if (!confirm('Are you sure you want to unlink your Lightning wallet? You will need email/password to log in.')) {
      return;
    }
    setLoading(true);
    setError('');
    try {
      const updatedUser = await api.unlinkLightning();
      onUserUpdate(updatedUser);
      setSuccess('Lightning wallet unlinked successfully');
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  const shortenPubkey = (pubkey) => {
    if (!pubkey) return null;
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert('Copied to clipboard!');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-profile" onClick={e => e.stopPropagation()}>
        <h2>👤 Profile Settings</h2>
        
        <div className="profile-tabs">
          <button 
            className={activeTab === 'info' ? 'active' : ''} 
            onClick={() => setActiveTab('info')}
          >
            Account Info
          </button>
          <button 
            className={activeTab === 'security' ? 'active' : ''} 
            onClick={() => setActiveTab('security')}
          >
            Security
          </button>
          <button 
            className={activeTab === 'connections' ? 'active' : ''} 
            onClick={() => setActiveTab('connections')}
          >
            Connections
          </button>
        </div>

        {error && <div className="auth-error">{error}</div>}
        {success && <div className="auth-success">{success}</div>}

        {activeTab === 'info' && (
          <div className="profile-section">
            <div className="profile-field">
              <label>Username</label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Enter username"
              />
              <span className="field-hint">2-30 characters, letters, numbers, underscores, hyphens</span>
            </div>

            <div className="profile-field">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Enter email (optional)"
              />
              <span className="field-hint">Used for login and notifications</span>
            </div>

            <div className="profile-field readonly">
              <label>Account Number</label>
              <div className="field-value">#{user.account_number || 'N/A'}</div>
            </div>

            <div className="profile-field readonly">
              <label>Member Since</label>
              <div className="field-value">
                {user.created_at ? new Date(user.created_at).toLocaleDateString() : 'Unknown'}
              </div>
            </div>

            <button 
              className="btn btn-primary"
              onClick={handleSaveProfile}
              disabled={loading}
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}

        {activeTab === 'security' && (
          <div className="profile-section">
            <h3>{user.password_hash ? 'Change Password' : 'Set Password'}</h3>
            <p className="section-hint">
              {user.password_hash 
                ? 'Update your login password'
                : 'Set a password to enable email login'}
            </p>

            {user.password_hash && (
              <div className="profile-field">
                <label>Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  placeholder="Enter current password"
                />
              </div>
            )}

            <div className="profile-field">
              <label>New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Enter new password"
                minLength={6}
              />
            </div>

            <div className="profile-field">
              <label>Confirm New Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                minLength={6}
              />
            </div>

            <button 
              className="btn btn-primary"
              onClick={handleChangePassword}
              disabled={loading || !newPassword || !confirmPassword}
            >
              {loading ? 'Updating...' : (user.password_hash ? 'Change Password' : 'Set Password')}
            </button>
          </div>
        )}

        {activeTab === 'connections' && (
          <div className="profile-section">
            <h3>Login Methods</h3>
            
            <div className="connection-item">
              <div className="connection-icon">⚡</div>
              <div className="connection-info">
                <div className="connection-name">Lightning Wallet</div>
                {user.lightning_pubkey ? (
                  <>
                    <div className="connection-status connected">
                      ✓ Connected
                    </div>
                    <div 
                      className="connection-detail pubkey"
                      onClick={() => copyToClipboard(user.lightning_pubkey)}
                      title="Click to copy full pubkey"
                    >
                      {shortenPubkey(user.lightning_pubkey)}
                    </div>
                  </>
                ) : (
                  <div className="connection-status disconnected">
                    Not connected
                  </div>
                )}
              </div>
              <div className="connection-action">
                {user.lightning_pubkey ? (
                  <button 
                    className="btn btn-small btn-outline btn-danger"
                    onClick={handleUnlinkLightning}
                    disabled={loading || (!user.email && !user.google_id)}
                    title={(!user.email && !user.google_id) ? 'Add email first' : 'Unlink wallet'}
                  >
                    Unlink
                  </button>
                ) : (
                  <button 
                    className="btn btn-small btn-lightning"
                    onClick={() => setShowLinkLightning(true)}
                  >
                    Link Wallet
                  </button>
                )}
              </div>
            </div>

            <div className="connection-item">
              <div className="connection-icon">📧</div>
              <div className="connection-info">
                <div className="connection-name">Email</div>
                {user.email ? (
                  <>
                    <div className="connection-status connected">
                      ✓ {user.email}
                    </div>
                    <div className="connection-detail">
                      {user.password_hash ? 'Password set' : 'No password (Google only)'}
                    </div>
                  </>
                ) : (
                  <div className="connection-status disconnected">
                    Not set
                  </div>
                )}
              </div>
            </div>

            {user.google_id && (
              <div className="connection-item">
                <div className="connection-icon">🔵</div>
                <div className="connection-info">
                  <div className="connection-name">Google</div>
                  <div className="connection-status connected">
                    ✓ Connected
                  </div>
                </div>
              </div>
            )}

            {!user.email && !user.google_id && user.lightning_pubkey && (
              <div className="connection-warning">
                ⚠️ Add an email address to have a backup login method
              </div>
            )}
          </div>
        )}

        <button className="btn btn-outline modal-close" onClick={onClose}>Close</button>

        {showLinkLightning && (
          <LinkLightningModal 
            onClose={() => setShowLinkLightning(false)}
            onSuccess={(updatedUser) => {
              onUserUpdate(updatedUser);
              setShowLinkLightning(false);
              setSuccess('Lightning wallet linked successfully!');
            }}
          />
        )}
      </div>
    </div>
  );
}

// Link Lightning Modal (for existing users)
function LinkLightningModal({ onClose, onSuccess }) {
  const [challenge, setChallenge] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const pollingRef = useRef(null);

  useEffect(() => {
    generateChallenge();
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const generateChallenge = async () => {
    setStatus('loading');
    setError('');
    try {
      const data = await api.getLnurlAuthChallenge();
      setChallenge(data);
      setStatus('ready');
      startPolling(data.k1);
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const startPolling = (k1) => {
    pollingRef.current = setInterval(async () => {
      try {
        const statusData = await api.getLnurlAuthStatus(k1);
        if (statusData.status === 'verified') {
          clearInterval(pollingRef.current);
          setStatus('linking');
          // Link to current account
          const result = await api.linkLightning(k1);
          onSuccess(result.user);
        } else if (statusData.status === 'expired') {
          clearInterval(pollingRef.current);
          setError('Challenge expired. Please try again.');
          setStatus('error');
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 2000);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal lightning-modal" onClick={e => e.stopPropagation()}>
        <h2>⚡ Link Lightning Wallet</h2>
        
        {status === 'loading' && (
          <div className="lightning-loading">
            <div className="spinner"></div>
            <p>Generating challenge...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="lightning-error">
            <p className="auth-error">{error}</p>
            <button className="btn btn-primary" onClick={generateChallenge}>
              Try Again
            </button>
          </div>
        )}

        {status === 'ready' && challenge && (
          <div className="lightning-qr-container">
            <p className="lightning-instructions">
              Scan with your Lightning wallet to link it to your account
            </p>
            
            <div className="qr-wrapper">
              <QRCodeSVG 
                value={challenge.uri}
                size={200}
                level="M"
                includeMargin={true}
              />
            </div>

            <div className="lightning-waiting">
              <div className="pulse-dot"></div>
              <span>Waiting for wallet signature...</span>
            </div>
          </div>
        )}

        {status === 'linking' && (
          <div className="lightning-loading">
            <div className="spinner"></div>
            <p>Linking wallet to your account...</p>
          </div>
        )}

        <button className="btn btn-outline modal-close" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function AdminPanel({ user, onClose }) {
  const [markets, setMarkets] = useState([]);
  const [selectedMarket, setSelectedMarket] = useState(null);
  const [resolution, setResolution] = useState('yes');
  const [notes, setNotes] = useState('');
  const [filter, setFilter] = useState('all');
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    loadMarkets();
  }, []);

  const loadMarkets = async () => {
    try {
      const data = await api.getAdminMarkets();
      setMarkets(data);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleResolve = async () => {
    if (!selectedMarket) return;
    if (!confirm(`Are you sure you want to resolve "${selectedMarket.title}" as ${resolution.toUpperCase()}? This action is immediate and cannot be undone.`)) return;
    
    setResolving(true);
    try {
      const result = await api.resolveMarket(selectedMarket.id, resolution, notes);
      alert(`Market resolved as ${resolution.toUpperCase()}!\n\nBets settled: ${result.bets_settled}\nOrders cancelled: ${result.orders_cancelled}`);
      loadMarkets();
      setSelectedMarket(null);
      setNotes('');
    } catch (err) {
      alert(err.message);
    }
    setResolving(false);
  };

  const filteredMarkets = markets.filter(m => {
    if (filter === 'all') return true;
    return m.type === filter;
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-fullscreen" onClick={e => e.stopPropagation()}>
        <h2>🔐 Admin Panel</h2>
        
        <div className="admin-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'event' ? 'active' : ''} onClick={() => setFilter('event')}>Event</button>
          <button className={filter === 'attendance' ? 'active' : ''} onClick={() => setFilter('attendance')}>Attendance</button>
          <button className={filter === 'winner' ? 'active' : ''} onClick={() => setFilter('winner')}>Winner</button>
        </div>

        <div className="admin-markets">
          {filteredMarkets.map(m => (
            <div key={m.id} className={`admin-market ${selectedMarket?.id === m.id ? 'selected' : ''}`}>
              <div className="am-header" onClick={() => setSelectedMarket(m)}>
                <span className="am-title">{m.grandmaster_name || 'Event'}: {m.title}</span>
                <span className={`status status-${m.status}`}>{m.status}</span>
              </div>
              <div className="am-stats">
                <span>Bets: {m.active_bets || 0}</span>
                <span>Volume: {formatSats(m.total_volume || 0)} sats</span>
              </div>
              {m.status === 'resolved' && m.resolution && (
                <div className="am-resolution">
                  Resolved: <strong>{m.resolution.toUpperCase()}</strong>
                </div>
              )}
            </div>
          ))}
        </div>

        {selectedMarket && selectedMarket.status === 'open' && (
          <div className="resolution-panel">
            <h3>Resolve: {selectedMarket.title}</h3>
            <div className="resolution-options">
              <label>
                <input 
                  type="radio" 
                  value="yes" 
                  checked={resolution === 'yes'}
                  onChange={() => setResolution('yes')}
                />
                YES
              </label>
              <label>
                <input 
                  type="radio" 
                  value="no" 
                  checked={resolution === 'no'}
                  onChange={() => setResolution('no')}
                />
                NO
              </label>
            </div>
            <textarea
              placeholder="Notes (optional)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
            <button 
              className="btn btn-danger" 
              onClick={handleResolve}
              disabled={resolving}
            >
              {resolving ? 'Resolving...' : `Resolve as ${resolution.toUpperCase()}`}
            </button>
          </div>
        )}

        <button className="btn btn-outline modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ==================== MAIN APP ====================
function App() {
  const { user, loading, login, register, googleLogin, lightningLogin, logout, refreshBalance, updateUser } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showLightningLogin, setShowLightningLogin] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showBotAdmin, setShowBotAdmin] = useState(false);
  const [showUserAdmin, setShowUserAdmin] = useState(false);
  const [showWhatsThePoint, setShowWhatsThePoint] = useState(false);
  const [eventMarket, setEventMarket] = useState(null);
  const [grandmasters, setGrandmasters] = useState([]);
  const [selectedMarket, setSelectedMarket] = useState(null);
  const [marketType, setMarketType] = useState('attendance');

  // Load data
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [event, gms] = await Promise.all([
        api.getEventMarket(),
        api.getGrandmasters(),
      ]);
      
      // Load order book for event market
      if (event?.id) {
        const eventWithBook = await api.getMarket(event.id);
        setEventMarket(eventWithBook);
      }
      
      setGrandmasters(gms);
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  };

  const handleSelectGM = async (gm, type) => {
    const marketId = type === 'attendance' ? gm.attendance_market_id : gm.winner_market_id;
    try {
      const market = await api.getMarket(marketId);
      setSelectedMarket(market);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleRefresh = async () => {
    await loadData();
    if (user) await refreshBalance();
    if (selectedMarket) {
      const updated = await api.getMarket(selectedMarket.id);
      setSelectedMarket(updated);
    }
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="app">
      <Header 
        user={user} 
        onLogout={logout}
        onShowWallet={() => setShowWallet(true)}
        onShowPortfolio={() => setShowPortfolio(true)}
        onShowProfile={() => setShowProfile(true)}
        onShowAdmin={() => setShowAdmin(true)}
        onShowBotAdmin={() => setShowBotAdmin(true)}
        onShowUserAdmin={() => setShowUserAdmin(true)}
        onShowLogin={() => setShowLogin(true)}
        onGoHome={() => {
          setSelectedMarket(null);
          setShowWhatsThePoint(false);
        }}
      />

      <main className="main">
        {showWhatsThePoint ? (
          <WhatsThePoint onClose={() => setShowWhatsThePoint(false)} />
        ) : selectedMarket ? (
          <MarketDetail
            market={selectedMarket}
            user={user}
            onBack={() => setSelectedMarket(null)}
            onLogin={() => setShowLogin(true)}
            onRefresh={handleRefresh}
          />
        ) : (
          <>
            <div className="intro-banner">
              <button 
                className="btn btn-whats-the-point"
                onClick={() => setShowWhatsThePoint(true)}
              >
                🎯 What's the Point?
              </button>
              <span className="intro-text">New to prediction markets? Learn how this works!</span>
            </div>

            <EventMarket
              market={eventMarket}
              user={user}
              onLogin={() => setShowLogin(true)}
              onRefresh={handleRefresh}
            />
            
            <ParticipantBrowser
              grandmasters={grandmasters}
              onSelectGM={handleSelectGM}
            />
            
            <WinnerBrowser
              grandmasters={grandmasters}
              onSelectGM={handleSelectGM}
            />
          </>
        )}
      </main>

      {!user && (
        <div className="login-banner" onClick={() => setShowLogin(true)}>
          Click here to login and start trading with Bitcoin ⚡
        </div>
      )}

      {showLogin && (
        <LoginModal 
          onLogin={login}
          onRegister={register}
          onGoogleLogin={googleLogin}
          onClose={() => setShowLogin(false)}
          onSwitchToLightning={() => {
            setShowLogin(false);
            setShowLightningLogin(true);
          }}
        />
      )}

      {showLightningLogin && (
        <LightningLoginModal 
          onComplete={lightningLogin}
          onClose={() => setShowLightningLogin(false)}
        />
      )}

      {showWallet && user && (
        <WalletModal user={user} onClose={() => setShowWallet(false)} onRefresh={refreshBalance} />
      )}

      {showPortfolio && user && (
        <PortfolioModal 
          user={user} 
          onClose={() => setShowPortfolio(false)} 
          onRefresh={refreshBalance}
          onSelectMarket={async (marketId) => {
            setShowPortfolio(false);
            try {
              const market = await api.getMarket(marketId);
              setSelectedMarket(market);
            } catch (err) {
              console.error('Failed to load market:', err);
            }
          }}
        />
      )}

      {showAdmin && user?.is_admin === 1 && (
        <AdminPanel user={user} onClose={() => setShowAdmin(false)} />
      )}

      {showProfile && user && (
        <ProfileModal user={user} onClose={() => setShowProfile(false)} onUserUpdate={updateUser} />
      )}

      {showBotAdmin && user?.is_admin === 1 && (
        <BotAdmin onClose={() => { setShowBotAdmin(false); loadData(); }} />
      )}

      {showUserAdmin && user?.is_admin === 1 && (
        <div className="modal-overlay" onClick={() => setShowUserAdmin(false)}>
          <div className="modal modal-fullscreen modal-user-admin" onClick={e => e.stopPropagation()}>
            <button className="btn btn-outline modal-close-btn" onClick={() => setShowUserAdmin(false)}>×</button>
            <UserAdmin currentUserId={user.id} onBalanceChange={refreshBalance} />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
