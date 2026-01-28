import { useState, useEffect, useCallback } from 'react';
import * as api from './api';

// Format satoshis
const formatSats = (sats) => {
  if (!sats && sats !== 0) return '-';
  return sats.toLocaleString();
};

// Shape type info for UI
const SHAPE_TYPES = {
  bell: { name: 'Bell Curve', icon: '🔔', description: 'Gaussian distribution - concentrate around a center point' },
  flat: { name: 'Flat', icon: '📏', description: 'Equal distribution across all price points' },
  exponential: { name: 'Exponential Decay', icon: '📉', description: 'Heavy at low prices, fading at higher prices' },
  logarithmic: { name: 'Logarithmic', icon: '📊', description: 'Decreasing returns as price rises' },
  sigmoid: { name: 'Sigmoid', icon: '〰️', description: 'Sharp transition around a midpoint' },
  parabolic: { name: 'Parabolic', icon: '⌒', description: 'Strongly favor low prices' },
  custom: { name: 'Custom', icon: '✏️', description: 'Draw your own curve' }
};

// Default parameters for each shape type
const DEFAULT_PARAMS = {
  bell: { mu: 20, sigma: 15 },
  flat: {},
  exponential: { decay: 0.08 },
  logarithmic: {},
  sigmoid: { midpoint: 25, steepness: 0.3 },
  parabolic: { maxPrice: 55 },
  custom: {}
};

// ==================== BOT ADMIN PANEL ====================
export default function BotAdmin({ onClose }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState(null);
  const [buyCurve, setBuyCurve] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deploying, setDeploying] = useState(false);

  // Config form state
  const [configForm, setConfigForm] = useState({
    max_acceptable_loss: 10000000,
    total_liquidity: 100000000,
    global_multiplier: 1.0,
    is_active: false
  });

  // Curve editor state
  const [curvePoints, setCurvePoints] = useState([]);
  const [newPoint, setNewPoint] = useState({ price: 10, amount: 100000 });

  // Shape library state
  const [shapes, setShapes] = useState([]);
  const [selectedShapeType, setSelectedShapeType] = useState('bell');
  const [shapeParams, setShapeParams] = useState(DEFAULT_PARAMS.bell);
  const [previewShape, setPreviewShape] = useState(null);
  const [shapeName, setShapeName] = useState('');

  // Market weights state
  const [weights, setWeights] = useState([]);

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    try {
      const [statsData, configData, curveData, marketsData, logData] = await Promise.all([
        api.getBotStats(),
        api.getBotConfig(),
        api.getBuyCurve('attendance'),
        api.getBotMarkets(),
        api.getBotLog(30)
      ]);
      
      setStats(statsData);
      setConfig(configData);
      setBuyCurve(curveData);
      setMarkets(marketsData);
      setLog(logData);
      
      // Initialize form with current config
      if (configData) {
        setConfigForm({
          max_acceptable_loss: configData.max_acceptable_loss,
          threshold_percent: configData.threshold_percent,
          global_multiplier: configData.global_multiplier,
          is_active: !!configData.is_active
        });
      }
      
      // Initialize curve points
      if (curveData?.price_points) {
        setCurvePoints(curveData.price_points);
      }
    } catch (err) {
      console.error('Failed to load bot data:', err);
      alert('Failed to load bot data: ' + err.message);
    }
    setLoading(false);
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      await api.updateBotConfig(configForm);
      await loadAllData();
      alert('Configuration saved!');
    } catch (err) {
      alert('Failed to save config: ' + err.message);
    }
    setSaving(false);
  };

  const handleSaveCurve = async () => {
    if (curvePoints.length === 0) {
      alert('Add at least one price point to the curve');
      return;
    }
    setSaving(true);
    try {
      await api.saveBuyCurve('attendance', curvePoints);
      await loadAllData();
      alert('Curve saved!');
    } catch (err) {
      alert('Failed to save curve: ' + err.message);
    }
    setSaving(false);
  };

  const handleAddPoint = () => {
    if (newPoint.price < 1 || newPoint.price > 99) {
      alert('Price must be between 1 and 99');
      return;
    }
    if (newPoint.amount < 100) {
      alert('Amount must be at least 100 sats');
      return;
    }
    // Check for duplicate price
    if (curvePoints.some(p => p.price === newPoint.price)) {
      alert('A point at this price already exists');
      return;
    }
    setCurvePoints([...curvePoints, { ...newPoint }].sort((a, b) => a.price - b.price));
    setNewPoint({ price: newPoint.price + 5, amount: 100000 });
  };

  const handleRemovePoint = (index) => {
    setCurvePoints(curvePoints.filter((_, i) => i !== index));
  };

  const handleDeployAll = async () => {
    if (!confirm('Deploy bot orders to ALL attendance markets?')) return;
    setDeploying(true);
    try {
      const result = await api.deployAllOrders();
      alert(`Deployed! ${result.deployed} markets, ${result.totalOrders} orders, ${formatSats(result.totalCost)} sats locked`);
      await loadAllData();
    } catch (err) {
      alert('Failed to deploy: ' + err.message);
    }
    setDeploying(false);
  };

  const handleWithdrawAll = async () => {
    if (!confirm('Withdraw ALL bot orders? This will cancel all open orders.')) return;
    setDeploying(true);
    try {
      const result = await api.withdrawAllOrders();
      alert(`Withdrawn! ${result.ordersCancelled} orders cancelled, ${formatSats(result.refund)} sats refunded`);
      await loadAllData();
    } catch (err) {
      alert('Failed to withdraw: ' + err.message);
    }
    setDeploying(false);
  };

  const handleToggleActive = async () => {
    const newActive = !configForm.is_active;
    setSaving(true);
    try {
      await api.updateBotConfig({ is_active: newActive });
      setConfigForm(prev => ({ ...prev, is_active: newActive }));
      await loadAllData();
    } catch (err) {
      alert('Failed to toggle: ' + err.message);
    }
    setSaving(false);
  };

  const handleMarketOverride = async (marketId, overrideType, multiplier = 1.0) => {
    try {
      await api.setMarketOverride(marketId, overrideType, multiplier);
      await loadAllData();
    } catch (err) {
      alert('Failed to set override: ' + err.message);
    }
  };

  // Calculate curve totals
  const curveTotalAmount = curvePoints.reduce((sum, p) => sum + p.amount, 0);
  const curveTotalCost = curvePoints.reduce((sum, p) => sum + Math.ceil(p.amount * (100 - p.price) / 100), 0);

  if (loading) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal modal-fullscreen" onClick={e => e.stopPropagation()}>
          <div className="bot-loading">Loading bot data...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-fullscreen bot-admin" onClick={e => e.stopPropagation()}>
        <div className="bot-header">
          <h2>🤖 Market Maker Bot</h2>
          <div className="bot-status">
            <span className={`status-indicator ${configForm.is_active ? 'active' : 'inactive'}`}>
              {configForm.is_active ? '● ACTIVE' : '○ INACTIVE'}
            </span>
            <button 
              className={`btn btn-small ${configForm.is_active ? 'btn-danger' : 'btn-success'}`}
              onClick={handleToggleActive}
              disabled={saving}
            >
              {configForm.is_active ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        </div>

        {/* RISK OVERVIEW PANEL */}
        <div className="bot-risk-panel">
          <div className="risk-metric critical">
            <label>Current Exposure</label>
            <value>{formatSats(stats?.risk?.currentExposure || 0)} sats</value>
            <progress 
              value={stats?.risk?.currentExposure || 0} 
              max={stats?.config?.maxAcceptableLoss || 10000000}
            />
            <span className="risk-percent">{stats?.risk?.exposurePercent || 0}% of Max Loss</span>
          </div>
          <div className="risk-metric success">
            <label>Max Loss (Guaranteed Cap)</label>
            <value>{formatSats(stats?.config?.maxAcceptableLoss)} sats</value>
            <span className="safe">✓ Cannot exceed this</span>
          </div>
          <div className="risk-metric">
            <label>Remaining Budget</label>
            <value>{formatSats((stats?.config?.maxAcceptableLoss || 0) - (stats?.risk?.currentExposure || 0))} sats</value>
            <span>Available before pullback = 0</span>
          </div>
          <div className="risk-metric">
            <label>Pullback Ratio</label>
            <value>{(parseFloat(stats?.risk?.pullbackRatio || 1) * 100).toFixed(1)}%</value>
            <span>Liquidity multiplier</span>
          </div>
          <div className="risk-metric">
            <label>Active Orders</label>
            <value>{stats?.offers?.orderCount || 0}</value>
            <span>{formatSats(stats?.offers?.totalOffered)} sats offered</span>
          </div>
          <div className="risk-metric">
            <label>Bot Balance</label>
            <value>{formatSats(stats?.balance?.total)} sats</value>
            <span>{formatSats(stats?.balance?.locked)} locked in orders</span>
          </div>
        </div>

        {/* TABS */}
        <div className="bot-tabs">
          <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>
            Overview
          </button>
          <button className={activeTab === 'curve' ? 'active' : ''} onClick={() => setActiveTab('curve')}>
            Buy Curve
          </button>
          <button className={activeTab === 'markets' ? 'active' : ''} onClick={() => setActiveTab('markets')}>
            Markets ({markets.length})
          </button>
          <button className={activeTab === 'config' ? 'active' : ''} onClick={() => setActiveTab('config')}>
            Configuration
          </button>
          <button className={activeTab === 'log' ? 'active' : ''} onClick={() => setActiveTab('log')}>
            Activity Log
          </button>
        </div>

        <div className="bot-content">
          {/* OVERVIEW TAB */}
          {activeTab === 'overview' && (
            <div className="bot-overview">
              <div className="overview-section">
                <h3>Quick Actions</h3>
                <div className="action-buttons">
                  <button 
                    className="btn btn-primary btn-large"
                    onClick={handleDeployAll}
                    disabled={deploying || !configForm.is_active}
                  >
                    {deploying ? 'Deploying...' : '🚀 Deploy All Orders'}
                  </button>
                  <button 
                    className="btn btn-danger btn-large"
                    onClick={handleWithdrawAll}
                    disabled={deploying}
                  >
                    {deploying ? 'Withdrawing...' : '⏹ Withdraw All Orders'}
                  </button>
                  <button 
                    className="btn btn-outline"
                    onClick={loadAllData}
                  >
                    🔄 Refresh Data
                  </button>
                </div>
              </div>

              <div className="overview-section">
                <h3>Offers by Price</h3>
                <div className="price-breakdown">
                  {stats?.offers?.byPrice?.length > 0 ? (
                    <table className="mini-table">
                      <thead>
                        <tr>
                          <th>YES Price</th>
                          <th>Amount Offered</th>
                          <th>Markets</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.offers.byPrice.map((row, i) => (
                          <tr key={i}>
                            <td>{row.price}%</td>
                            <td>{formatSats(row.amount)} sats</td>
                            <td>{row.markets}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="empty-state">No active offers</p>
                  )}
                </div>
              </div>

              <div className="overview-section">
                <h3>Top Exposure Markets</h3>
                {stats?.topExposure?.length > 0 ? (
                  <table className="mini-table">
                    <thead>
                      <tr>
                        <th>GM</th>
                        <th>Exposure</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.topExposure.map((m, i) => (
                        <tr key={i}>
                          <td>{m.grandmaster_name || m.title}</td>
                          <td>{formatSats(m.exposure)} sats</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="empty-state">No exposure yet</p>
                )}
              </div>

              <div className="overview-section">
                <h3>Bot Balance</h3>
                <div className="balance-info">
                  <div><label>Available:</label> {formatSats(stats?.balance?.available)} sats</div>
                  <div><label>Locked in Orders:</label> {formatSats(stats?.balance?.locked)} sats</div>
                  <div><label>Total:</label> {formatSats(stats?.balance?.total)} sats</div>
                </div>
              </div>
            </div>
          )}

          {/* CURVE EDITOR TAB */}
          {activeTab === 'curve' && (
            <div className="bot-curve-editor">
              <div className="curve-info">
                <p>
                  <strong>Draw your curve!</strong> Click and drag the bars to adjust how much liquidity to offer at each price.
                  Higher bars = more sats offered at that YES probability.
                </p>
              </div>

              {/* PRESET BUTTONS - Mathematically meaningful shapes */}
              <div className="curve-presets">
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('flat', {});
                      const scaled = result.normalized_points.map(p => ({ price: p.price, amount: Math.round(p.weight * 1000000) }));
                      setCurvePoints(scaled);
                    } catch (err) {
                      // Fallback to local calculation
                      const flat = [5,10,15,20,25,30,35,40,45,50].map(p => ({ price: p, amount: 100000 }));
                      setCurvePoints(flat);
                    }
                  }}
                >
                  📏 Flat
                </button>
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('bell', { mu: 20, sigma: 15 });
                      const scaled = result.normalized_points.map(p => ({ price: p.price, amount: Math.round(p.weight * 1000000) }));
                      setCurvePoints(scaled);
                    } catch (err) {
                      // Fallback
                      const bell = [
                        { price: 5, amount: 50000 },
                        { price: 10, amount: 100000 },
                        { price: 15, amount: 150000 },
                        { price: 20, amount: 200000 },
                        { price: 25, amount: 200000 },
                        { price: 30, amount: 150000 },
                        { price: 35, amount: 100000 },
                        { price: 40, amount: 75000 },
                        { price: 45, amount: 50000 },
                        { price: 50, amount: 25000 }
                      ];
                      setCurvePoints(bell);
                    }
                  }}
                >
                  🔔 Bell (μ=20)
                </button>
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('exponential', { decay: 0.08 });
                      const scaled = result.normalized_points.map(p => ({ price: p.price, amount: Math.round(p.weight * 1000000) }));
                      setCurvePoints(scaled);
                    } catch (err) {
                      console.error('Exponential preview failed:', err);
                    }
                  }}
                >
                  📉 Exponential
                </button>
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('sigmoid', { midpoint: 25, steepness: 0.3 });
                      const scaled = result.normalized_points.map(p => ({ price: p.price, amount: Math.round(p.weight * 1000000) }));
                      setCurvePoints(scaled);
                    } catch (err) {
                      console.error('Sigmoid preview failed:', err);
                    }
                  }}
                >
                  〰️ Sigmoid
                </button>
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('parabolic', { maxPrice: 55 });
                      const scaled = result.normalized_points.map(p => ({ price: p.price, amount: Math.round(p.weight * 1000000) }));
                      setCurvePoints(scaled);
                    } catch (err) {
                      console.error('Parabolic preview failed:', err);
                    }
                  }}
                >
                  ⌒ Parabolic
                </button>
                <button 
                  className="btn btn-small btn-danger"
                  onClick={() => setCurvePoints([])}
                >
                  🗑️ Clear
                </button>
              </div>

              {/* DRAWABLE CURVE - SVG Based */}
              <div className="curve-drawable">
                <div className="curve-y-axis">
                  <span>300k</span>
                  <span>200k</span>
                  <span>100k</span>
                  <span>0</span>
                </div>
                <div className="curve-canvas">
                  {[5,10,15,20,25,30,35,40,45,50].map(price => {
                    const point = curvePoints.find(p => p.price === price);
                    const amount = point?.amount || 0;
                    const heightPercent = Math.min((amount / 300000) * 100, 100);
                    
                    return (
                      <div 
                        key={price}
                        className="curve-bar-container"
                        onMouseDown={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const updateAmount = (clientY) => {
                            const relativeY = rect.bottom - clientY;
                            const newAmount = Math.max(0, Math.min(300000, Math.round((relativeY / rect.height) * 300000 / 10000) * 10000));
                            setCurvePoints(prev => {
                              const existing = prev.find(p => p.price === price);
                              if (existing) {
                                return prev.map(p => p.price === price ? { ...p, amount: newAmount } : p);
                              } else if (newAmount > 0) {
                                return [...prev, { price, amount: newAmount }].sort((a,b) => a.price - b.price);
                              }
                              return prev;
                            });
                          };
                          
                          updateAmount(e.clientY);
                          
                          const handleMouseMove = (moveEvent) => updateAmount(moveEvent.clientY);
                          const handleMouseUp = () => {
                            window.removeEventListener('mousemove', handleMouseMove);
                            window.removeEventListener('mouseup', handleMouseUp);
                          };
                          
                          window.addEventListener('mousemove', handleMouseMove);
                          window.addEventListener('mouseup', handleMouseUp);
                        }}
                      >
                        <div 
                          className="curve-bar-fill"
                          style={{ height: `${heightPercent}%` }}
                        >
                          <span className="bar-amount">{amount > 0 ? `${(amount/1000).toFixed(0)}k` : ''}</span>
                        </div>
                        <span className="bar-price">{price}%</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* SUMMARY TABLE */}
              <div className="curve-summary">
                <div className="summary-stat">
                  <label>Total Liquidity (per market)</label>
                  <value>{formatSats(curveTotalAmount)} sats</value>
                </div>
                <div className="summary-stat">
                  <label>Total Cost (NO side)</label>
                  <value>{formatSats(curveTotalCost)} sats</value>
                </div>
                <div className="summary-stat">
                  <label>Price Points</label>
                  <value>{curvePoints.filter(p => p.amount > 0).length}</value>
                </div>
              </div>

              {/* DETAILED TABLE (Collapsible) */}
              <details className="curve-details">
                <summary>📋 View Detailed Table</summary>
                <table className="curve-table">
                  <thead>
                    <tr>
                      <th>YES Price</th>
                      <th>Amount (sats)</th>
                      <th>Bot Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {curvePoints.filter(p => p.amount > 0).map((point, i) => (
                      <tr key={i}>
                        <td>{point.price}%</td>
                        <td>
                          <input 
                            type="number"
                            value={point.amount}
                            min="0"
                            step="10000"
                            onChange={e => {
                              const newAmount = parseInt(e.target.value) || 0;
                              setCurvePoints(prev => prev.map(p => 
                                p.price === point.price ? { ...p, amount: newAmount } : p
                              ));
                            }}
                            style={{ width: '100px' }}
                          />
                        </td>
                        <td>{formatSats(Math.ceil(point.amount * (100 - point.price) / 100))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>

              <div className="curve-actions">
                <button 
                  className="btn btn-success btn-large"
                  onClick={handleSaveCurve}
                  disabled={saving || curvePoints.filter(p => p.amount > 0).length === 0}
                >
                  {saving ? 'Saving...' : '💾 Save Curve'}
                </button>
                <p className="save-note">
                  After saving, click "Deploy All Orders" to apply changes to markets.
                </p>
              </div>
            </div>
          )}

          {/* MARKETS TAB */}
          {activeTab === 'markets' && (
            <div className="bot-markets">
              <div className="markets-header">
                <h3>Attendance Markets</h3>
                <div className="batch-actions">
                  <button 
                    className="btn btn-small"
                    onClick={() => {
                      const ids = markets.filter(m => !m.override_type).map(m => m.id);
                      if (confirm(`Apply 2x multiplier to ${ids.length} markets?`)) {
                        api.batchSetOverride(ids, 'multiply', 2.0).then(loadAllData);
                      }
                    }}
                  >
                    2x All Default
                  </button>
                  <button 
                    className="btn btn-small"
                    onClick={() => {
                      const ids = markets.map(m => m.id);
                      if (confirm(`Reset all ${ids.length} market overrides?`)) {
                        api.batchSetOverride(ids, null, 1.0).then(loadAllData);
                      }
                    }}
                  >
                    Reset All
                  </button>
                </div>
              </div>

              <table className="markets-table">
                <thead>
                  <tr>
                    <th>GM</th>
                    <th>Rating</th>
                    <th>Status</th>
                    <th>Override</th>
                    <th>Total Offered</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map(m => (
                    <tr key={m.id} className={m.override_type === 'disable' ? 'disabled' : ''}>
                      <td>{m.grandmaster_name}</td>
                      <td>{m.fide_rating}</td>
                      <td>
                        <span className={`status-badge ${m.bot_enabled ? 'enabled' : 'disabled'}`}>
                          {m.bot_enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                      <td>
                        {m.override_type === 'multiply' && `${m.multiplier}x`}
                        {m.override_type === 'disable' && 'Disabled'}
                        {m.override_type === 'replace' && 'Custom'}
                        {!m.override_type && 'Default'}
                      </td>
                      <td>{formatSats(m.total_offered)}</td>
                      <td className="market-actions">
                        <select 
                          value={m.override_type || ''}
                          onChange={e => {
                            const type = e.target.value || null;
                            handleMarketOverride(m.id, type, type === 'multiply' ? 2.0 : 1.0);
                          }}
                        >
                          <option value="">Default</option>
                          <option value="multiply">Multiply</option>
                          <option value="disable">Disable</option>
                        </select>
                        {m.override_type === 'multiply' && (
                          <input 
                            type="number" 
                            className="multiplier-input"
                            min="0.1" 
                            max="10" 
                            step="0.1"
                            value={m.multiplier || 1}
                            onChange={e => handleMarketOverride(m.id, 'multiply', parseFloat(e.target.value))}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* CONFIG TAB */}
          {activeTab === 'config' && (
            <div className="bot-config">
              <h3>Bot Configuration</h3>
              
              <div className="config-form">
                <div className="config-group">
                  <label>
                    Max Loss (sats) — <strong>Guaranteed Cap</strong>
                    <input 
                      type="number"
                      min="100000"
                      step="1000000"
                      value={configForm.max_acceptable_loss}
                      onChange={e => setConfigForm({ ...configForm, max_acceptable_loss: parseInt(e.target.value) || 0 })}
                    />
                    <span className="help-text">
                      The absolute maximum you can lose. The bot automatically reduces offers as exposure increases,
                      guaranteeing this limit is never exceeded.
                    </span>
                  </label>
                </div>

                <div className="config-group">
                  <label>
                    Global Multiplier (Liquidity Scale)
                    <input 
                      type="number"
                      min="0"
                      max="10"
                      step="0.1"
                      value={configForm.global_multiplier}
                      onChange={e => setConfigForm({ ...configForm, global_multiplier: parseFloat(e.target.value) || 1 })}
                    />
                    <span className="help-text">
                      Multiplies ALL offer amounts. Higher = more liquidity offered (but same max loss).
                    </span>
                  </label>
                </div>

                <div className="config-preview">
                  <h4>How It Works</h4>
                  <div className="pullback-explanation">
                    <p><strong>Linear Pullback Formula:</strong></p>
                    <code>pullback_ratio = 1 - (exposure / max_loss)</code>
                    <ul>
                      <li>At <strong>0%</strong> exposure → <strong>100%</strong> liquidity offered</li>
                      <li>At <strong>50%</strong> exposure → <strong>50%</strong> liquidity offered</li>
                      <li>At <strong>100%</strong> exposure → <strong>0%</strong> liquidity (stops offering)</li>
                    </ul>
                    <p className="guarantee">
                      ✓ This guarantees max loss of <strong>{formatSats(configForm.max_acceptable_loss)} sats</strong> can never be exceeded.
                    </p>
                  </div>
                </div>

                <button 
                  className="btn btn-success btn-large"
                  onClick={handleSaveConfig}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : '💾 Save Configuration'}
                </button>
              </div>
            </div>
          )}

          {/* LOG TAB */}
          {activeTab === 'log' && (
            <div className="bot-log">
              <h3>Activity Log</h3>
              <table className="log-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Details</th>
                    <th>Exposure Change</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((entry, i) => (
                    <tr key={i} className={`log-${entry.action}`}>
                      <td className="log-time">
                        {new Date(entry.created_at).toLocaleString()}
                      </td>
                      <td className="log-action">
                        {entry.action === 'pullback' && '⚠️ Pullback'}
                        {entry.action === 'deploy_all' && '🚀 Deploy All'}
                        {entry.action === 'deploy_market' && '📦 Deploy Market'}
                        {entry.action === 'withdraw_all' && '⏹ Withdraw All'}
                        {entry.action === 'config_updated' && '⚙️ Config Update'}
                        {!['pullback', 'deploy_all', 'deploy_market', 'withdraw_all', 'config_updated'].includes(entry.action) && entry.action}
                      </td>
                      <td className="log-details">
                        {entry.details && (
                          <code>{entry.details.substring(0, 100)}{entry.details.length > 100 ? '...' : ''}</code>
                        )}
                      </td>
                      <td className="log-exposure">
                        {entry.exposure_before !== null && entry.exposure_after !== null && (
                          <span>
                            {formatSats(entry.exposure_before)} → {formatSats(entry.exposure_after)}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {log.length === 0 && (
                    <tr>
                      <td colSpan="4" className="empty">No activity logged</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <button className="btn btn-outline modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
