import { useState, useEffect, useCallback } from 'react';
import * as api from './api';

// Format sats with thousands separator
const formatSats = (sats) => {
  if (sats === undefined || sats === null) return '0';
  return Math.abs(sats).toLocaleString();
};

// Format date/time
const formatDate = (dateStr) => {
  if (!dateStr) return 'Never';
  return new Date(dateStr).toLocaleString();
};

// Relative time (e.g., "2 hours ago")
const timeAgo = (dateStr) => {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);
  
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
};

export default function UserAdmin({ currentUserId, onBalanceChange }) {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('created_at');
  const [order, setOrder] = useState('DESC');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [selectedUser, setSelectedUser] = useState(null);
  const [userDetails, setUserDetails] = useState(null);
  const [userLogins, setUserLogins] = useState([]);
  const [userActivity, setUserActivity] = useState(null);
  const [userAuditLog, setUserAuditLog] = useState([]);
  const [userTransactions, setUserTransactions] = useState([]);
  const [detailTab, setDetailTab] = useState('overview');
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  
  // Modal states
  const [showBalanceModal, setShowBalanceModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showDisableModal, setShowDisableModal] = useState(false);
  const [balanceAmount, setBalanceAmount] = useState('');
  const [balanceReason, setBalanceReason] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [noteText, setNoteText] = useState('');
  const [disableReason, setDisableReason] = useState('');
  const [showResetDbModal, setShowResetDbModal] = useState(false);
  const [resetDbPassword, setResetDbPassword] = useState('');
  const [resetDbResult, setResetDbResult] = useState(null);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restorePassword, setRestorePassword] = useState('');
  const [availableBackups, setAvailableBackups] = useState([]);
  const [selectedBackup, setSelectedBackup] = useState('');
  
  // Withdrawal settings state
  const [withdrawalSettings, setWithdrawalSettings] = useState(null);
  const [withdrawalPauseLoading, setWithdrawalPauseLoading] = useState(false);

  // Load withdrawal settings
  const loadWithdrawalSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/withdrawals/settings', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      setWithdrawalSettings(data);
    } catch (err) {
      console.error('Failed to load withdrawal settings:', err);
    }
  }, []);

  // Toggle auto-withdrawal pause
  const toggleWithdrawalPause = async () => {
    setWithdrawalPauseLoading(true);
    try {
      const newPauseState = !withdrawalSettings?.auto_withdraw_paused;
      const response = await fetch('/api/admin/withdrawals/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          auto_withdraw_paused: newPauseState,
          pause_reason: newPauseState ? 'Paused via admin panel' : null
        })
      });
      const data = await response.json();
      if (response.ok) {
        setWithdrawalSettings(data.settings);
      } else {
        setError(data.error || 'Failed to update withdrawal settings');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setWithdrawalPauseLoading(false);
    }
  };

  // Load stats
  const loadStats = useCallback(async () => {
    try {
      const data = await api.getAdminStats();
      setStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }, []);

  // Load users
  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getAdminUsers({ search, sort, order, limit, offset });
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, sort, order, limit, offset]);

  // Load user details
  const loadUserDetails = useCallback(async (userId) => {
    try {
      const [details, logins, activity, auditLog, transactions] = await Promise.all([
        api.getAdminUser(userId),
        api.getAdminUserLogins(userId, { limit: 20 }),
        api.getAdminUserActivity(userId, { limit: 30 }),
        api.getAdminUserAuditLog(userId),
        api.getAdminUserTransactions(userId, { limit: 50 }),
      ]);
      setUserDetails(details);
      setUserLogins(logins.logins || []);
      setUserActivity(activity);
      setUserAuditLog(auditLog || []);
      setUserTransactions(transactions.transactions || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadUsers();
    loadWithdrawalSettings();
  }, [loadStats, loadUsers, loadWithdrawalSettings]);

  useEffect(() => {
    if (selectedUser) {
      loadUserDetails(selectedUser);
    }
  }, [selectedUser, loadUserDetails]);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      loadUsers();
    }, 300);
    return () => clearTimeout(timer);
  }, [search]); // eslint-disable-line

  // Handle sort change
  const handleSort = (field) => {
    if (sort === field) {
      setOrder(order === 'ASC' ? 'DESC' : 'ASC');
    } else {
      setSort(field);
      setOrder('DESC');
    }
  };

  // Actions
  const handleAdjustBalance = async () => {
    const amount = parseInt(balanceAmount);
    if (isNaN(amount) || amount === 0) {
      setError('Enter a valid amount');
      return;
    }
    if (!balanceReason || balanceReason.length < 5) {
      setError('Enter a reason (min 5 chars)');
      return;
    }
    setActionLoading(true);
    try {
      await api.adjustUserBalance(selectedUser, amount, balanceReason);
      await loadUserDetails(selectedUser);
      await loadUsers();
      // If we modified the currently logged-in user's balance, refresh the header
      if (selectedUser === currentUserId && onBalanceChange) {
        await onBalanceChange();
      }
      setShowBalanceModal(false);
      setBalanceAmount('');
      setBalanceReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleAdmin = async () => {
    if (!confirm(`${userDetails?.is_admin ? 'Remove' : 'Grant'} admin access for ${userDetails?.username}?`)) return;
    setActionLoading(true);
    try {
      await api.toggleUserAdmin(selectedUser);
      await loadUserDetails(selectedUser);
      await loadUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleDisabled = async () => {
    setActionLoading(true);
    try {
      await api.toggleUserDisabled(selectedUser, disableReason);
      await loadUserDetails(selectedUser);
      await loadUsers();
      setShowDisableModal(false);
      setDisableReason('');
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handlePasswordReset = async () => {
    if (!newPassword || newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setActionLoading(true);
    try {
      await api.forcePasswordReset(selectedUser, newPassword);
      await loadUserDetails(selectedUser);
      setShowPasswordModal(false);
      setNewPassword('');
      alert('Password reset successfully');
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddNote = async () => {
    if (!noteText || noteText.length < 3) {
      setError('Note must be at least 3 characters');
      return;
    }
    setActionLoading(true);
    try {
      await api.addUserNote(selectedUser, noteText);
      await loadUserDetails(selectedUser);
      setShowNoteModal(false);
      setNoteText('');
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleResetDatabase = async () => {
    setActionLoading(true);
    setResetDbResult(null);
    try {
      const response = await fetch('/api/admin/reset-database', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ confirm_code: resetDbPassword })
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.message || data.error || 'Reset failed');
      } else {
        setResetDbResult(data);
        alert('Database reset successful! The page will reload.');
        window.location.reload();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // Render stats cards
  const renderStats = () => {
    if (!stats) return null;
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{stats.total_users}</div>
          <div className="stat-label">Total Users</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.active_24h}</div>
          <div className="stat-label">Active 24h</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.active_7d}</div>
          <div className="stat-label">Active 7d</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{formatSats(stats.total_user_balances)}</div>
          <div className="stat-label">Total Balances (sats)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.admin_users}</div>
          <div className="stat-label">Admins</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{stats.disabled_users}</div>
          <div className="stat-label">Disabled</div>
        </div>
        <div className="stat-card" style={{ 
          backgroundColor: withdrawalSettings?.auto_withdraw_paused ? '#ff4444' : '#2d3748',
          border: withdrawalSettings?.auto_withdraw_paused ? '2px solid #ff0000' : '1px solid #4a5568'
        }}>
          <div className="stat-label" style={{ marginBottom: '8px', fontWeight: 'bold' }}>
            ⚡ Auto Withdrawals
          </div>
          <button
            onClick={toggleWithdrawalPause}
            disabled={withdrawalPauseLoading}
            style={{
              padding: '10px 20px',
              fontSize: '1em',
              fontWeight: 'bold',
              backgroundColor: withdrawalSettings?.auto_withdraw_paused ? '#4caf50' : '#ff4444',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: withdrawalPauseLoading ? 'wait' : 'pointer',
              width: '100%'
            }}
          >
            {withdrawalPauseLoading ? '...' : 
              withdrawalSettings?.auto_withdraw_paused ? '▶️ RESUME' : '⏸️ PAUSE ALL'}
          </button>
          <div style={{ fontSize: '0.75em', marginTop: '6px', opacity: 0.8 }}>
            {withdrawalSettings?.auto_withdraw_paused 
              ? '🔴 ALL withdrawals need approval' 
              : '🟢 Auto-approving < 100k'}
          </div>
        </div>
        <div className="stat-card danger-card">
          <button className="danger-btn" onClick={() => setShowResetDbModal(true)}>
            ☢️ Reset Database
          </button>
          <button className="restore-btn" onClick={async () => {
            try {
              const response = await fetch('/api/admin/backups', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
              });
              const data = await response.json();
              setAvailableBackups(data.backups || []);
              setShowRestoreModal(true);
            } catch (err) {
              setError('Failed to load backups: ' + err.message);
            }
          }} style={{ marginTop: '5px', backgroundColor: '#4caf50' }}>
            🔄 Restore Backup
          </button>
        </div>
      </div>
    );
  };

  // Render user list
  const renderUserList = () => (
    <div className="user-list-section">
      <div className="user-list-header">
        <input
          type="text"
          placeholder="Search by email, username, or account #..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
        <span className="user-count">{total} users</span>
      </div>
      
      <div className="user-table-container">
        <table className="user-table">
          <thead>
            <tr>
              <th onClick={() => handleSort('account_number')} className="sortable">
                # {sort === 'account_number' && (order === 'ASC' ? '↑' : '↓')}
              </th>
              <th onClick={() => handleSort('username')} className="sortable">
                Username {sort === 'username' && (order === 'ASC' ? '↑' : '↓')}
              </th>
              <th onClick={() => handleSort('email')} className="sortable">
                Email {sort === 'email' && (order === 'ASC' ? '↑' : '↓')}
              </th>
              <th onClick={() => handleSort('balance_sats')} className="sortable">
                Balance {sort === 'balance_sats' && (order === 'ASC' ? '↑' : '↓')}
              </th>
              <th onClick={() => handleSort('last_login_at')} className="sortable">
                Last Login {sort === 'last_login_at' && (order === 'ASC' ? '↑' : '↓')}
              </th>
              <th>Status</th>
              <th onClick={() => handleSort('created_at')} className="sortable">
                Created {sort === 'created_at' && (order === 'ASC' ? '↑' : '↓')}
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr 
                key={user.id} 
                onClick={() => setSelectedUser(user.id)}
                className={`${selectedUser === user.id ? 'selected' : ''} ${user.is_disabled ? 'disabled-user' : ''}`}
              >
                <td>{user.account_number || '-'}</td>
                <td>
                  {user.username}
                  {user.is_admin && <span className="badge admin">Admin</span>}
                </td>
                <td>{user.email || '-'}</td>
                <td className="balance">{formatSats(user.balance_sats)}</td>
                <td>{timeAgo(user.last_login_at)}</td>
                <td>
                  {user.is_disabled ? (
                    <span className="badge disabled">Disabled</span>
                  ) : (
                    <span className="badge active">Active</span>
                  )}
                </td>
                <td>{timeAgo(user.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {/* Pagination */}
      <div className="pagination">
        <button 
          onClick={() => setOffset(Math.max(0, offset - limit))} 
          disabled={offset === 0}
        >
          ← Previous
        </button>
        <span>
          Showing {offset + 1}-{Math.min(offset + limit, total)} of {total}
        </span>
        <button 
          onClick={() => setOffset(offset + limit)} 
          disabled={offset + limit >= total}
        >
          Next →
        </button>
      </div>
    </div>
  );

  // Render user details panel
  const renderUserDetails = () => {
    if (!userDetails) return <div className="user-details-placeholder">Select a user to view details</div>;
    
    return (
      <div className="user-details">
        <div className="user-details-header">
          <h3>
            {userDetails.username}
            {userDetails.is_admin && <span className="badge admin">Admin</span>}
            {userDetails.is_disabled && <span className="badge disabled">Disabled</span>}
          </h3>
          <span className="account-number">Account #{userDetails.account_number}</span>
        </div>
        
        <div className="detail-tabs">
          <button className={detailTab === 'overview' ? 'active' : ''} onClick={() => setDetailTab('overview')}>
            Overview
          </button>
          <button className={detailTab === 'transactions' ? 'active' : ''} onClick={() => setDetailTab('transactions')}>
            Transactions
          </button>
          <button className={detailTab === 'logins' ? 'active' : ''} onClick={() => setDetailTab('logins')}>
            Logins
          </button>
          <button className={detailTab === 'activity' ? 'active' : ''} onClick={() => setDetailTab('activity')}>
            Trading
          </button>
          <button className={detailTab === 'audit' ? 'active' : ''} onClick={() => setDetailTab('audit')}>
            Audit Log
          </button>
        </div>
        
        {detailTab === 'overview' && (
          <div className="detail-content">
            <div className="detail-grid">
              <div className="detail-item">
                <label>Email</label>
                <span>{userDetails.email || 'Not set'}</span>
              </div>
              <div className="detail-item">
                <label>Balance</label>
                <span className="balance">{formatSats(userDetails.balance_sats)} sats</span>
              </div>
              <div className="detail-item">
                <label>Created</label>
                <span>{formatDate(userDetails.created_at)}</span>
              </div>
              <div className="detail-item">
                <label>Last Login</label>
                <span>{formatDate(userDetails.last_login_at)}</span>
              </div>
              <div className="detail-item">
                <label>Total Deposits</label>
                <span className="positive">{formatSats(userDetails.total_deposits)} sats</span>
              </div>
              <div className="detail-item">
                <label>Total Withdrawals</label>
                <span className="negative">{formatSats(userDetails.total_withdrawals)} sats</span>
              </div>
              <div className="detail-item">
                <label>Total Orders</label>
                <span>{userDetails.total_orders} ({userDetails.open_orders} open)</span>
              </div>
              <div className="detail-item">
                <label>Total Bets</label>
                <span>{userDetails.total_bets} ({userDetails.active_bets} active)</span>
              </div>
              <div className="detail-item">
                <label>Bets Won</label>
                <span>{userDetails.bets_won}</span>
              </div>
              <div className="detail-item">
                <label>Login Count</label>
                <span>{userDetails.login_count}</span>
              </div>
              <div className="detail-item">
                <label>Lightning</label>
                <span>{userDetails.lightning_pubkey ? '✓ Linked' : 'Not linked'}</span>
              </div>
              <div className="detail-item">
                <label>Google</label>
                <span>{userDetails.google_id ? '✓ Linked' : 'Not linked'}</span>
              </div>
            </div>
            
            <div className="action-buttons">
              <button className="action-btn primary" onClick={() => setShowBalanceModal(true)}>
                Adjust Balance
              </button>
              <button className="action-btn" onClick={handleToggleAdmin}>
                {userDetails.is_admin ? 'Remove Admin' : 'Make Admin'}
              </button>
              <button 
                className={`action-btn ${userDetails.is_disabled ? 'success' : 'danger'}`}
                onClick={() => userDetails.is_disabled ? handleToggleDisabled() : setShowDisableModal(true)}
              >
                {userDetails.is_disabled ? 'Enable Account' : 'Disable Account'}
              </button>
              <button className="action-btn" onClick={() => setShowPasswordModal(true)}>
                Reset Password
              </button>
              <button className="action-btn" onClick={() => setShowNoteModal(true)}>
                Add Note
              </button>
            </div>
          </div>
        )}
        
        {detailTab === 'transactions' && (
          <div className="detail-content">
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Balance After</th>
                  <th>Status</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {userTransactions.map((tx) => (
                  <tr key={tx.id}>
                    <td>{tx.type}</td>
                    <td className={tx.amount_sats >= 0 ? 'positive' : 'negative'}>
                      {tx.amount_sats >= 0 ? '+' : ''}{formatSats(tx.amount_sats)}
                    </td>
                    <td>{formatSats(tx.balance_after)}</td>
                    <td><span className={`badge ${tx.status}`}>{tx.status}</span></td>
                    <td>{timeAgo(tx.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        
        {detailTab === 'logins' && (
          <div className="detail-content">
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>IP Address</th>
                  <th>User Agent</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {userLogins.map((login) => (
                  <tr key={login.id}>
                    <td><span className={`badge ${login.login_method}`}>{login.login_method}</span></td>
                    <td>{login.ip_address}</td>
                    <td className="truncate" title={login.user_agent}>{login.user_agent?.substring(0, 40)}...</td>
                    <td>{formatDate(login.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        
        {detailTab === 'activity' && userActivity && (
          <div className="detail-content">
            <div className="pnl-summary">
              <div className="pnl-item positive">
                <span>Won</span>
                <span>{formatSats(userActivity.pnl?.total_won || 0)} sats</span>
              </div>
              <div className="pnl-item negative">
                <span>Lost</span>
                <span>{formatSats(userActivity.pnl?.total_lost || 0)} sats</span>
              </div>
              <div className={`pnl-item ${userActivity.pnl?.net >= 0 ? 'positive' : 'negative'}`}>
                <span>Net P&L</span>
                <span>{userActivity.pnl?.net >= 0 ? '+' : ''}{formatSats(userActivity.pnl?.net || 0)} sats</span>
              </div>
            </div>
            
            <h4>Recent Bets</h4>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th>Price</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {userActivity.bets?.slice(0, 20).map((bet) => (
                  <tr key={bet.id}>
                    <td>{bet.market_title?.substring(0, 30)}</td>
                    <td><span className={`badge ${bet.user_side}`}>{bet.user_side}</span></td>
                    <td>{bet.price_sats}%</td>
                    <td>{formatSats(bet.amount_sats)}</td>
                    <td><span className={`badge ${bet.status}`}>{bet.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        
        {detailTab === 'audit' && (
          <div className="detail-content">
            <table className="mini-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Admin</th>
                  <th>Details</th>
                  <th>Old → New</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {userAuditLog.map((log) => (
                  <tr key={log.id}>
                    <td><span className={`badge ${log.action}`}>{log.action}</span></td>
                    <td>{log.admin_username || log.admin_email}</td>
                    <td className="truncate" title={log.details}>{log.details?.substring(0, 40)}</td>
                    <td>{log.old_value && log.new_value ? `${log.old_value} → ${log.new_value}` : '-'}</td>
                    <td>{timeAgo(log.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  // Modals
  const renderModals = () => (
    <>
      {showBalanceModal && (
        <div className="modal-overlay" onClick={() => setShowBalanceModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Adjust Balance</h3>
            <p>Current balance: {formatSats(userDetails?.balance_sats)} sats</p>
            <div className="form-group">
              <label>Amount (positive to add, negative to deduct)</label>
              <input
                type="number"
                value={balanceAmount}
                onChange={(e) => setBalanceAmount(e.target.value)}
                placeholder="e.g., 10000 or -5000"
              />
            </div>
            <div className="form-group">
              <label>Reason (required)</label>
              <textarea
                value={balanceReason}
                onChange={(e) => setBalanceReason(e.target.value)}
                placeholder="e.g., Promotional bonus, Refund for issue #123"
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowBalanceModal(false)}>Cancel</button>
              <button className="primary" onClick={handleAdjustBalance} disabled={actionLoading}>
                {actionLoading ? 'Processing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {showPasswordModal && (
        <div className="modal-overlay" onClick={() => setShowPasswordModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset Password</h3>
            <p>Force reset password for {userDetails?.username}</p>
            <div className="form-group">
              <label>New Password (min 6 characters)</label>
              <input
                type="text"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password"
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowPasswordModal(false)}>Cancel</button>
              <button className="primary" onClick={handlePasswordReset} disabled={actionLoading}>
                {actionLoading ? 'Processing...' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {showNoteModal && (
        <div className="modal-overlay" onClick={() => setShowNoteModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add Note</h3>
            <p>Add a note to {userDetails?.username}'s audit log</p>
            <div className="form-group">
              <label>Note</label>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="e.g., User contacted support about..."
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowNoteModal(false)}>Cancel</button>
              <button className="primary" onClick={handleAddNote} disabled={actionLoading}>
                {actionLoading ? 'Processing...' : 'Add Note'}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {showDisableModal && (
        <div className="modal-overlay" onClick={() => setShowDisableModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Disable Account</h3>
            <p className="warning">⚠️ This will prevent {userDetails?.username} from logging in or trading.</p>
            <div className="form-group">
              <label>Reason (optional but recommended)</label>
              <textarea
                value={disableReason}
                onChange={(e) => setDisableReason(e.target.value)}
                placeholder="e.g., Suspicious activity, User request"
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => setShowDisableModal(false)}>Cancel</button>
              <button className="danger" onClick={handleToggleDisabled} disabled={actionLoading}>
                {actionLoading ? 'Processing...' : 'Disable Account'}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {showResetDbModal && (
        <div className="modal-overlay" onClick={() => setShowResetDbModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>☢️ RESET DATABASE</h3>
            <p className="warning" style={{ color: '#ff4444', fontWeight: 'bold' }}>
              ⚠️ DANGER: This will delete ALL data (users, orders, bets, etc.)
            </p>
            <p style={{ fontSize: '0.9em', color: '#888' }}>
              Backup tables will be created before deletion for recovery.
            </p>
            <div className="form-group">
              <label>Enter password to confirm:</label>
              <input
                type="password"
                value={resetDbPassword}
                onChange={(e) => setResetDbPassword(e.target.value)}
                placeholder="Enter reset password"
                autoComplete="off"
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => { setShowResetDbModal(false); setResetDbPassword(''); }}>Cancel</button>
              <button 
                className="danger" 
                onClick={handleResetDatabase} 
                disabled={actionLoading || !resetDbPassword}
                style={{ backgroundColor: '#ff2222' }}
              >
                {actionLoading ? 'RESETTING...' : '☢️ NUKE DATABASE'}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {showRestoreModal && (
        <div className="modal-overlay" onClick={() => setShowRestoreModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>🔄 RESTORE FROM BACKUP</h3>
            <p style={{ color: '#4caf50', fontWeight: 'bold' }}>
              Select a backup to restore:
            </p>
            {availableBackups.length === 0 ? (
              <p style={{ color: '#888' }}>No backups available.</p>
            ) : (
              <div className="form-group">
                <label>Available Backups:</label>
                <select 
                  value={selectedBackup} 
                  onChange={(e) => setSelectedBackup(e.target.value)}
                  style={{ width: '100%', padding: '8px' }}
                >
                  <option value="">-- Select a backup --</option>
                  {availableBackups.map(b => (
                    <option key={b.timestamp} value={b.timestamp}>
                      {b.date} ({b.tables.length} tables)
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-group">
              <label>Enter password to confirm (restore789):</label>
              <input
                type="password"
                value={restorePassword}
                onChange={(e) => setRestorePassword(e.target.value)}
                placeholder="Enter restore password"
                autoComplete="off"
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => { setShowRestoreModal(false); setRestorePassword(''); setSelectedBackup(''); }}>Cancel</button>
              <button 
                className="primary" 
                onClick={async () => {
                  if (!selectedBackup) {
                    setError('Please select a backup');
                    return;
                  }
                  setActionLoading(true);
                  try {
                    const response = await fetch('/api/admin/restore-database', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                      },
                      body: JSON.stringify({ timestamp: selectedBackup, confirm_code: restorePassword })
                    });
                    const data = await response.json();
                    if (!response.ok) {
                      setError(data.message || data.error || 'Restore failed');
                    } else {
                      alert(`Database restored! ${data.restored.length} tables recovered. Page will reload.`);
                      window.location.reload();
                    }
                  } catch (err) {
                    setError(err.message);
                  } finally {
                    setActionLoading(false);
                  }
                }} 
                disabled={actionLoading || !selectedBackup || !restorePassword}
                style={{ backgroundColor: '#4caf50' }}
              >
                {actionLoading ? 'RESTORING...' : '🔄 RESTORE BACKUP'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="user-admin">
      <h2>👥 User Management</h2>
      
      {error && (
        <div className="error-banner">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      
      {renderStats()}
      
      <div className="user-admin-layout">
        <div className="user-list-panel">
          {loading ? <div className="loading">Loading users...</div> : renderUserList()}
        </div>
        <div className="user-details-panel">
          {renderUserDetails()}
        </div>
      </div>
      
      {renderModals()}
    </div>
  );
}
