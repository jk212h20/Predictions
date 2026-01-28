import { useState, useEffect, useCallback } from 'react';
import * as api from './api';
import './App.css';

// Constants
const SATS_PER_SHARE = 1000;

// Format satoshis
const formatSats = (sats) => {
  if (!sats) return '0';
  return sats.toLocaleString();
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

  const login = async (email, username) => {
    const { token, user } = await api.demoLogin(email, username);
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

  return { user, loading, login, logout, refreshBalance };
}

// ==================== COMPONENTS ====================

function Header({ user, onLogout, onShowWallet, onShowAdmin }) {
  return (
    <header className="header">
      <div className="header-left">
        <h1>₿ Bitcoin Chess 960 Championship</h1>
        <span className="header-date">Prospera • March 16-22, 2026</span>
      </div>
      <div className="header-right">
        {user ? (
          <>
            <span className="balance" onClick={onShowWallet}>
              ⚡ {formatSats(user.balance_sats)} sats
            </span>
            <span className="username">{user.username || user.email}</span>
            {user.is_admin === 1 && (
              <button className="btn btn-small" onClick={onShowAdmin}>Admin</button>
            )}
            <button className="btn btn-small btn-outline" onClick={onLogout}>Logout</button>
          </>
        ) : (
          <span className="login-prompt">Login to trade</span>
        )}
      </div>
    </header>
  );
}

function LoginModal({ onLogin, onClose }) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onLogin(email, username);
      onClose();
    } catch (err) {
      alert(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Login / Sign Up</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder="Username (optional)"
            value={username}
            onChange={e => setUsername(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading...' : 'Continue'}
          </button>
        </form>
        <p className="modal-note">
          Demo mode: Enter any email to create an account with 100,000 sats.
        </p>
      </div>
    </div>
  );
}

function WalletModal({ user, onClose, onRefresh }) {
  const [depositAmount, setDepositAmount] = useState(100000);
  const [invoice, setInvoice] = useState(null);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawInvoice, setWithdrawInvoice] = useState('');

  const handleDeposit = async () => {
    try {
      const inv = await api.createDeposit(depositAmount);
      setInvoice(inv);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSimulatePayment = async () => {
    try {
      await api.simulatePayment(invoice.payment_hash);
      await api.checkDeposit(invoice.payment_hash);
      await onRefresh();
      setInvoice(null);
      alert('Deposit credited!');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleWithdraw = async () => {
    try {
      await api.withdraw(withdrawInvoice, parseInt(withdrawAmount));
      await onRefresh();
      setWithdrawAmount('');
      setWithdrawInvoice('');
      alert('Withdrawal sent!');
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <h2>⚡ Wallet</h2>
        <div className="wallet-balance">
          <span>Balance:</span>
          <strong>{formatSats(user.balance_sats)} sats</strong>
        </div>

        <div className="wallet-section">
          <h3>Deposit</h3>
          {!invoice ? (
            <>
              <input
                type="number"
                value={depositAmount}
                onChange={e => setDepositAmount(parseInt(e.target.value))}
                min="1000"
                step="1000"
              />
              <button className="btn btn-primary" onClick={handleDeposit}>
                Generate Invoice
              </button>
            </>
          ) : (
            <div className="invoice-display">
              <code>{invoice.payment_request}</code>
              <p className="invoice-note">
                In production, scan this with your Lightning wallet.
                <br />For testing:
              </p>
              <button className="btn btn-success" onClick={handleSimulatePayment}>
                Simulate Payment (Test Mode)
              </button>
              <button className="btn btn-outline" onClick={() => setInvoice(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>

        <div className="wallet-section">
          <h3>Withdraw</h3>
          <input
            type="number"
            placeholder="Amount (sats)"
            value={withdrawAmount}
            onChange={e => setWithdrawAmount(e.target.value)}
          />
          <input
            type="text"
            placeholder="Lightning Invoice"
            value={withdrawInvoice}
            onChange={e => setWithdrawInvoice(e.target.value)}
          />
          <button 
            className="btn btn-primary" 
            onClick={handleWithdraw}
            disabled={!withdrawAmount || !withdrawInvoice}
          >
            Withdraw
          </button>
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

  const totalPayout = shares * SATS_PER_SHARE;
  const cost = side === 'yes' 
    ? Math.ceil(totalPayout * price / 100)
    : Math.ceil(totalPayout * (100 - price) / 100);

  const handleTrade = async () => {
    if (!user) {
      onLogin();
      return;
    }
    setLoading(true);
    try {
      await api.placeOrder(market.id, side, price, totalPayout);
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
                <span>{o.price_cents}%</span>
                <span>{formatSats(o.total_sats)} sats</span>
              </div>
            ))}
            {market.orderBook.yes.length === 0 && <span className="empty">No orders</span>}
          </div>
          <div className="ob-side ob-no">
            <h4>NO Orders</h4>
            {market.orderBook.no.slice(0, 5).map((o, i) => (
              <div key={i} className="ob-row">
                <span>{o.price_cents}%</span>
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

function GMBrowser({ grandmasters, onSelectGM, marketType, setMarketType }) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('odds'); // 'odds' or 'rating'

  const filtered = grandmasters
    .filter(gm => gm.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sortBy === 'odds') {
        const aOdds = a.attendance_yes_price || 0;
        const bOdds = b.attendance_yes_price || 0;
        return bOdds - aOdds; // Higher odds first
      }
      return b.fide_rating - a.fide_rating; // Higher rating first
    });

  return (
    <div className="gm-browser">
      <div className="gm-browser-header">
        <h2>♟️ Grandmaster Markets</h2>
        <div className="market-type-toggle">
          <button 
            className={marketType === 'attendance' ? 'active' : ''}
            onClick={() => setMarketType('attendance')}
          >
            Attendance
          </button>
          <button 
            className={marketType === 'winner' ? 'active' : ''}
            onClick={() => setMarketType('winner')}
          >
            Winner
          </button>
        </div>
      </div>
      
      <div className="gm-controls">
        <input
          type="text"
          placeholder="Search grandmaster..."
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
            onClick={() => onSelectGM(gm, marketType)}
          >
            <div className="gm-info">
              <span className="gm-name">{gm.name}</span>
              <span className="gm-details">{gm.country} • {gm.fide_rating}</span>
            </div>
            <div className="gm-odds">
              {gm.attendance_yes_price ? (
                <span className="odds-badge">{gm.attendance_yes_price}%</span>
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

  if (!market) return null;

  const totalPayout = shares * SATS_PER_SHARE;
  const cost = side === 'yes' 
    ? Math.ceil(totalPayout * price / 100)
    : Math.ceil(totalPayout * (100 - price) / 100);

  const handleTrade = async () => {
    if (!user) {
      onLogin();
      return;
    }
    setLoading(true);
    try {
      await api.placeOrder(market.id, side, price, totalPayout);
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

        <div className="order-book">
          <h3>Order Book</h3>
          <div className="ob-container">
            <div className="ob-side ob-yes">
              <h4>YES Bids</h4>
              {market.orderBook?.yes.map((o, i) => (
                <div key={i} className="ob-row">
                  <span className="ob-price">{o.price_cents}%</span>
                  <span className="ob-amount">{formatSats(o.total_sats)} sats</span>
                  <div className="ob-bar" style={{ width: `${Math.min(o.total_sats / 1000, 100)}%` }} />
                </div>
              ))}
              {(!market.orderBook?.yes || market.orderBook.yes.length === 0) && (
                <span className="empty">No bids</span>
              )}
            </div>
            <div className="ob-side ob-no">
              <h4>NO Bids</h4>
              {market.orderBook?.no.map((o, i) => (
                <div key={i} className="ob-row">
                  <span className="ob-price">{o.price_cents}%</span>
                  <span className="ob-amount">{formatSats(o.total_sats)} sats</span>
                  <div className="ob-bar ob-bar-no" style={{ width: `${Math.min(o.total_sats / 1000, 100)}%` }} />
                </div>
              ))}
              {(!market.orderBook?.no || market.orderBook.no.length === 0) && (
                <span className="empty">No bids</span>
              )}
            </div>
          </div>
        </div>

        {market.recentTrades && market.recentTrades.length > 0 && (
          <div className="recent-trades">
            <h3>Recent Trades</h3>
            {market.recentTrades.map((t, i) => (
              <div key={i} className="trade-row">
                <span>{t.price_cents}%</span>
                <span>{formatSats(t.amount_sats)} sats</span>
                <span className="trade-time">{new Date(t.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
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

  const handleInitiate = async () => {
    if (!selectedMarket) return;
    if (!confirm(`Are you sure you want to resolve "${selectedMarket.title}" as ${resolution.toUpperCase()}?`)) return;
    
    try {
      await api.initiateResolution(selectedMarket.id, resolution, notes);
      alert('Resolution initiated. Will be confirmed in 24 hours unless cancelled.');
      loadMarkets();
      setSelectedMarket(null);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCancel = async (marketId) => {
    try {
      await api.cancelResolution(marketId);
      alert('Resolution cancelled');
      loadMarkets();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleEmergencyConfirm = async (marketId) => {
    const code = prompt('Enter emergency code:');
    if (!code) return;
    try {
      await api.confirmResolution(marketId, code);
      alert('Market resolved!');
      loadMarkets();
    } catch (err) {
      alert(err.message);
    }
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
              {m.status === 'pending_resolution' && (
                <div className="am-actions">
                  <button className="btn btn-small btn-danger" onClick={() => handleCancel(m.id)}>
                    Cancel Resolution
                  </button>
                  <button className="btn btn-small btn-warning" onClick={() => handleEmergencyConfirm(m.id)}>
                    Emergency Confirm
                  </button>
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
            <button className="btn btn-danger" onClick={handleInitiate}>
              Initiate Resolution (24hr delay)
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
  const { user, loading, login, logout, refreshBalance } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
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
        onShowAdmin={() => setShowAdmin(true)}
      />

      <main className="main">
        {selectedMarket ? (
          <MarketDetail
            market={selectedMarket}
            user={user}
            onBack={() => setSelectedMarket(null)}
            onLogin={() => setShowLogin(true)}
            onRefresh={handleRefresh}
          />
        ) : (
          <>
            <EventMarket
              market={eventMarket}
              user={user}
              onLogin={() => setShowLogin(true)}
              onRefresh={handleRefresh}
            />
            
            <GMBrowser
              grandmasters={grandmasters}
              onSelectGM={handleSelectGM}
              marketType={marketType}
              setMarketType={setMarketType}
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
        <LoginModal onLogin={login} onClose={() => setShowLogin(false)} />
      )}

      {showWallet && user && (
        <WalletModal user={user} onClose={() => setShowWallet(false)} onRefresh={refreshBalance} />
      )}

      {showAdmin && user?.is_admin === 1 && (
        <AdminPanel user={user} onClose={() => setShowAdmin(false)} />
      )}
    </div>
  );
}

export default App;
