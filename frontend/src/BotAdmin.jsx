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
  
  // Deployment preview state
  const [deploymentPreview, setDeploymentPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  
  // User balance for max_loss validation
  const [userBalance, setUserBalance] = useState(0);

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
  
  // Saved custom curves
  const [savedCurves, setSavedCurves] = useState([]);
  
  // Two-sided liquidity: crossover point (prices < crossover are YES, >= crossover are NO)
  const [crossoverPoint, setCrossoverPoint] = useState(25);
  
  // Tier management state
  const [tiers, setTiers] = useState([]);
  const [loadingTiers, setLoadingTiers] = useState(false);
  const [expandedTier, setExpandedTier] = useState(null);
  const [tierMarkets, setTierMarkets] = useState({});
  
  // Track which tier is being dragged and its local value
  const [draggingTier, setDraggingTier] = useState(null);
  const [localTierValues, setLocalTierValues] = useState({});
  
  // Withdrawal admin state
  const [pendingWithdrawals, setPendingWithdrawals] = useState([]);
  const [pendingOnchainWithdrawals, setPendingOnchainWithdrawals] = useState([]);
  const [channelBalance, setChannelBalance] = useState(null);
  const [onchainBalance, setOnchainBalance] = useState(null);
  const [loadingWithdrawals, setLoadingWithdrawals] = useState(false);
  const [processingWithdrawal, setProcessingWithdrawal] = useState(null);
  
  // Reconciliation state
  const [reconciliationData, setReconciliationData] = useState(null);
  const [loadingReconciliation, setLoadingReconciliation] = useState(false);
  const [reconciliationView, setReconciliationView] = useState('overview'); // overview, ln-deposits, ln-withdrawals, onchain-deposits, onchain-withdrawals
  const [matchData, setMatchData] = useState(null);
  
  // Withdrawal card expansion state
  const [expandedWithdrawal, setExpandedWithdrawal] = useState(null);
  
  // Pullback thresholds state
  const [pullbackStatus, setPullbackStatus] = useState(null);
  const [thresholds, setThresholds] = useState([]);
  const [loadingPullback, setLoadingPullback] = useState(false);
  const [newThreshold, setNewThreshold] = useState({ exposure: 25, pullback: 75 });

  useEffect(() => {
    loadAllData();
    loadSavedCurves();
  }, []);
  
  // Load saved custom curves
  const loadSavedCurves = async () => {
    try {
      const shapes = await api.getShapes();
      setSavedCurves(shapes || []);
    } catch (err) {
      console.error('Failed to load saved curves:', err);
    }
  };

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

  // Load deployment preview
  const loadDeploymentPreview = async () => {
    setLoadingPreview(true);
    try {
      const preview = await api.getDeploymentPreview();
      setDeploymentPreview(preview);
    } catch (err) {
      console.error('Failed to load deployment preview:', err);
      alert('Failed to load deployment preview: ' + err.message);
    }
    setLoadingPreview(false);
  };

  // Load tier summary
  const loadTiers = async () => {
    setLoadingTiers(true);
    try {
      const tiersData = await api.getTierSummary();
      setTiers(tiersData || []);
    } catch (err) {
      console.error('Failed to load tiers:', err);
    }
    setLoadingTiers(false);
  };

  // Load markets for a specific tier
  const loadTierMarkets = async (tier) => {
    try {
      const markets = await api.getTierMarkets(tier);
      setTierMarkets(prev => ({ ...prev, [tier]: markets }));
    } catch (err) {
      console.error(`Failed to load tier ${tier} markets:`, err);
    }
  };

  // Handle tier budget change - preserves the adjusted tier's value
  const handleTierBudgetChange = async (tier, newBudget, clearLocalState = false) => {
    setSaving(true);
    try {
      const result = await api.setTierBudget(tier, newBudget);
      // Merge results: keep user's chosen value for the adjusted tier, update others
      const updatedTiers = (result.tiers || []).map(t => {
        if (t.tier === tier) {
          return { ...t, budgetPercent: newBudget };
        }
        return t;
      });
      setTiers(updatedTiers);
    } catch (err) {
      alert('Failed to update tier budget: ' + err.message);
    }
    setSaving(false);
    // Clear local drag state after API completes
    if (clearLocalState) {
      setDraggingTier(null);
      setLocalTierValues({});
    }
  };

  // Initialize weights from likelihood scores
  const handleInitializeFromScores = async () => {
    if (!confirm('Initialize all market weights based on likelihood scores? This will reset current weights.')) return;
    setSaving(true);
    try {
      const result = await api.initializeFromScores();
      setTiers(result.tiers || []);
      alert('Weights initialized from likelihood scores!');
    } catch (err) {
      alert('Failed to initialize from scores: ' + err.message);
    }
    setSaving(false);
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
          <div className="bot-header-stats">
            <span className="header-stat" title="Current Exposure / Max Loss">
              📊 {stats?.risk?.exposurePercent || 0}%
              <progress 
                value={stats?.risk?.currentExposure || 0} 
                max={stats?.config?.maxAcceptableLoss || 10000000}
              />
            </span>
            <span className="header-stat" title={`Budget: ${formatSats(stats?.config?.maxAcceptableLoss)} sats`}>
              💰 {formatSats((stats?.config?.maxAcceptableLoss || 0) - (stats?.risk?.currentExposure || 0))}
            </span>
            <span className="header-stat" title={`${stats?.offers?.orderCount || 0} orders, ${formatSats(stats?.offers?.totalOffered)} sats offered`}>
              📋 {stats?.offers?.orderCount || 0}
            </span>
            <span className="header-stat" title={`Total: ${formatSats(stats?.balance?.total)} sats, ${formatSats(stats?.balance?.locked)} locked`}>
              💵 {formatSats(stats?.balance?.available)}
            </span>
          </div>
          <span className={`status-indicator ${configForm.is_active ? 'active' : 'inactive'}`}>
            {configForm.is_active ? '● ACTIVE' : '○ INACTIVE'}
          </span>
        </div>

        {/* TABS */}
        <div className="bot-tabs">
          <button className={activeTab === 'overview' ? 'active' : ''} onClick={() => setActiveTab('overview')}>
            Overview
          </button>
          <button className={activeTab === 'deploy' ? 'active' : ''} onClick={() => {
            setActiveTab('deploy');
            loadDeploymentPreview();
          }}>
            🚀 Deploy
          </button>
          <button className={activeTab === 'tiers' ? 'active' : ''} onClick={() => {
            setActiveTab('tiers');
            loadTiers();
          }}>
            🎯 Tiers
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
          <button 
            className={activeTab === 'withdrawals' ? 'active' : ''} 
            onClick={async () => {
              setActiveTab('withdrawals');
              setLoadingWithdrawals(true);
              try {
                const [withdrawals, balance, onchainWithdrawals, onchainBal] = await Promise.all([
                  api.getAdminPendingWithdrawals(),
                  api.getChannelBalance(),
                  api.getAdminOnchainPendingWithdrawals(),
                  api.getOnchainBalance().catch(() => null)
                ]);
                setPendingWithdrawals(withdrawals || []);
                setChannelBalance(balance);
                setPendingOnchainWithdrawals(onchainWithdrawals || []);
                setOnchainBalance(onchainBal);
              } catch (err) {
                console.error('Failed to load withdrawals:', err);
              }
              setLoadingWithdrawals(false);
            }}
          >
            💸 Withdrawals {(pendingWithdrawals.length + pendingOnchainWithdrawals.length) > 0 && `(${pendingWithdrawals.length + pendingOnchainWithdrawals.length})`}
          </button>
          <button 
            className={activeTab === 'reconciliation' ? 'active' : ''} 
            onClick={async () => {
              setActiveTab('reconciliation');
              setLoadingReconciliation(true);
              try {
                const data = await api.getReconciliationOverview();
                setReconciliationData(data);
              } catch (err) {
                console.error('Failed to load reconciliation data:', err);
              }
              setLoadingReconciliation(false);
            }}
          >
            🔍 Reconciliation
          </button>
          <button 
            className={activeTab === 'pullback' ? 'active' : ''} 
            onClick={async () => {
              setActiveTab('pullback');
              setLoadingPullback(true);
              try {
                const [status, thresholdsData] = await Promise.all([
                  api.getPullbackStatus(),
                  api.getThresholds()
                ]);
                setPullbackStatus(status);
                setThresholds(thresholdsData || []);
              } catch (err) {
                console.error('Failed to load pullback data:', err);
              }
              setLoadingPullback(false);
            }}
          >
            📊 Pullback
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

          {/* CURVE EDITOR TAB - Dynamic points with percentages that total 100% */}
          {activeTab === 'curve' && (
            <div className="bot-curve-editor">
              <div className="curve-info">
                <p>
                  <strong>Two-Sided Market Making!</strong> Drag bars to adjust allocation. 
                  <span className="yes-text">🟢 YES orders</span> (below crossover) attract buyers who think it'll happen.
                  <span className="no-text">🔴 NO orders</span> (above crossover) attract buyers who think it won't.
                  The crossover point divides your liquidity between both sides.
                </p>
              </div>

              {/* BUDGET INFO - Above the slider */}
              <div className="crossover-stats">
                <div className="stat yes">
                  <span className="stat-label">🟢 YES Budget:</span>
                  <span className="stat-value">
                    {(curvePoints.filter(p => p.price < crossoverPoint).reduce((s, p) => s + (p.weight || 0), 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="stat no">
                  <span className="stat-label">🔴 NO Budget:</span>
                  <span className="stat-value">
                    {(curvePoints.filter(p => p.price >= crossoverPoint).reduce((s, p) => s + (p.weight || 0), 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="stat spread">
                  <span className="stat-label">📊 Spread:</span>
                  <span className="stat-value">
                    {(() => {
                      const yesPoints = curvePoints.filter(p => p.price < crossoverPoint && (p.weight || 0) > 0.005);
                      const noPoints = curvePoints.filter(p => p.price >= crossoverPoint && (p.weight || 0) > 0.005);
                      if (yesPoints.length === 0 || noPoints.length === 0) return 'N/A';
                      const highestYes = Math.max(...yesPoints.map(p => p.price));
                      const lowestNo = Math.min(...noPoints.map(p => p.price));
                      return `${lowestNo - highestYes}% (${highestYes}% → ${lowestNo}%)`;
                    })()}
                  </span>
                </div>
              </div>

              {/* DRAWABLE CURVE WITH INTEGRATED CROSSOVER SLIDER */}
              <div className="curve-drawable">
                <div className="curve-y-axis">
                  <span>50%</span>
                  <span>25%</span>
                  <span>10%</span>
                  <span>0%</span>
                </div>
                <div className="curve-main">
                  <div className="curve-canvas">
                  {curvePoints.sort((a, b) => a.price - b.price).map(point => {
                    const weight = point.weight || 0;
                    const heightPercent = Math.min((weight / 0.5) * 100, 100);
                    const displayPercent = (weight * 100).toFixed(1);
                    
                    return (
                      <div 
                        key={point.price}
                        className="curve-bar-container"
                        onMouseDown={(e) => {
                          // Prevent drag if clicking delete button
                          if (e.target.classList.contains('delete-point')) return;
                          
                          const rect = e.currentTarget.getBoundingClientRect();
                          const updateWeight = (clientY) => {
                            const relativeY = rect.bottom - clientY;
                            let newWeight = Math.max(0, Math.min(0.5, (relativeY / rect.height) * 0.5));
                            newWeight = Math.round(newWeight * 200) / 200; // Round to 0.5%
                            
                            setCurvePoints(prev => {
                              let points = [...prev];
                              const idx = points.findIndex(p => p.price === point.price);
                              if (idx === -1) return prev;
                              
                              const oldWeight = points[idx].weight || 0;
                              
                              // Calculate sum of OTHER non-zero points
                              const otherPoints = points.filter((p, i) => i !== idx && p.weight > 0);
                              const otherTotal = otherPoints.reduce((sum, p) => sum + p.weight, 0);
                              
                              // Set this point's new weight
                              points[idx] = { ...points[idx], weight: newWeight };
                              
                              // Scale OTHER non-zero points proportionally to keep sum = 1
                              // Points at 0 stay at 0 (they're not in otherPoints)
                              if (otherTotal > 0) {
                                const remaining = Math.max(0, 1 - newWeight);
                                const scale = remaining / otherTotal;
                                points = points.map((p, i) => {
                                  if (i === idx) return p; // Already set
                                  if (p.weight === 0) return p; // Stay at 0
                                  return { ...p, weight: p.weight * scale };
                                });
                              }
                              
                              // Final normalization
                              const total = points.reduce((sum, p) => sum + p.weight, 0);
                              if (total > 0 && Math.abs(total - 1) > 0.001) {
                                points = points.map(p => ({ ...p, weight: p.weight / total }));
                              }
                              
                              return points;
                            });
                          };
                          
                          updateWeight(e.clientY);
                          
                          const handleMouseMove = (moveEvent) => updateWeight(moveEvent.clientY);
                          const handleMouseUp = () => {
                            window.removeEventListener('mousemove', handleMouseMove);
                            window.removeEventListener('mouseup', handleMouseUp);
                          };
                          
                          window.addEventListener('mousemove', handleMouseMove);
                          window.addEventListener('mouseup', handleMouseUp);
                        }}
                      >
                        <button 
                          className="delete-point"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (curvePoints.length <= 1) {
                              alert('Must have at least 1 point');
                              return;
                            }
                            setCurvePoints(prev => {
                              const remaining = prev.filter(p => p.price !== point.price);
                              // Renormalize
                              const total = remaining.reduce((sum, p) => sum + p.weight, 0);
                              if (total > 0) {
                                return remaining.map(p => ({ ...p, weight: p.weight / total }));
                              }
                              return remaining;
                            });
                          }}
                          title="Delete this point"
                        >
                          ×
                        </button>
                        <div 
                          className={`curve-bar-fill ${point.price < crossoverPoint ? 'yes-side' : 'no-side'}`}
                          style={{ height: `${heightPercent}%` }}
                        >
                          <span className="bar-amount">{weight > 0.005 ? `${displayPercent}%` : ''}</span>
                        </div>
                        <span className="bar-price">{point.price}%</span>
                      </div>
                    );
                  })}
                  </div>
                  
                </div>
              </div>

              {/* CROSSOVER SLIDER - Below the chart */}
              <div className="crossover-slider-standalone">
                <div className="crossover-slider-row">
                  <span className="crossover-label-yes">🟢 YES ← {crossoverPoint}%</span>
                  <input 
                    type="range"
                    min="5"
                    max="50"
                    step="1"
                    value={crossoverPoint}
                    onChange={e => setCrossoverPoint(parseInt(e.target.value))}
                    className="crossover-slider"
                    style={{
                      flex: 1,
                      background: `linear-gradient(to right, #27ae60 0%, #27ae60 ${((crossoverPoint - 5) / 45) * 100}%, #e74c3c ${((crossoverPoint - 5) / 45) * 100}%, #e74c3c 100%)`
                    }}
                  />
                  <span className="crossover-label-no">{crossoverPoint}% → NO 🔴</span>
                </div>
              </div>

              {/* PRESET BUTTONS */}
              <div className="curve-presets">
                <span className="preset-label">Presets:</span>
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('flat', {});
                      setCurvePoints(result.normalized_points.map(p => ({ price: p.price, weight: p.weight })));
                    } catch (err) {
                      setCurvePoints([5,10,15,20,25,30,35,40,45,50].map(p => ({ price: p, weight: 0.1 })));
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
                      setCurvePoints(result.normalized_points.map(p => ({ price: p.price, weight: p.weight })));
                    } catch (err) { console.error(err); }
                  }}
                >
                  🔔 Bell
                </button>
                
                {/* SAVED CUSTOM CURVES */}
                {savedCurves.length > 0 && (
                  <>
                    <span className="preset-divider">|</span>
                    <span className="preset-label">Saved:</span>
                    {savedCurves.map(curve => (
                      <div key={curve.id} className="custom-curve-item">
                        <button 
                          className={`btn btn-small ${curve.is_default ? 'btn-primary' : 'btn-custom'}`}
                          onClick={() => {
                            console.log('Loading curve:', curve);
                            try {
                              let points = curve.normalized_points;
                              // Parse if it's a string
                              if (typeof points === 'string') {
                                points = JSON.parse(points);
                              }
                              if (Array.isArray(points) && points.length > 0) {
                                setCurvePoints(points.map(p => ({ price: p.price, weight: p.weight })));
                                console.log('Loaded points:', points);
                              } else {
                                alert('This curve has no saved points');
                              }
                            } catch (err) {
                              console.error('Failed to load curve:', err);
                              alert('Failed to load curve: ' + err.message);
                            }
                          }}
                          title={`Load "${curve.name}"${curve.is_default ? ' (ACTIVE)' : ''}`}
                        >
                          {curve.is_default ? '✓ ' : '✏️ '}{curve.name}
                        </button>
                        {!curve.is_default && (
                          <button 
                            className="btn btn-small btn-success"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!confirm(`Set "${curve.name}" as the active curve for all deployments?`)) return;
                              try {
                                await api.setDefaultShape(curve.id);
                                await loadSavedCurves();
                                alert(`"${curve.name}" is now the active curve!`);
                              } catch (err) {
                                alert('Failed to set active: ' + err.message);
                              }
                            }}
                            title={`Set "${curve.name}" as active`}
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.7rem' }}
                          >
                            Set Active
                          </button>
                        )}
                        <button 
                          className="btn btn-small btn-delete-curve"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`Delete curve "${curve.name}"?`)) return;
                            try {
                              await api.deleteShape(curve.id);
                              await loadSavedCurves();
                            } catch (err) {
                              alert('Failed to delete: ' + err.message);
                            }
                          }}
                          title={`Delete "${curve.name}"`}
                        >
                          🗑️
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>

              {/* ADD POINT CONTROLS */}
              <div className="add-point-controls">
                <label>Add Point:</label>
                <input 
                  type="number"
                  min="1"
                  max="99"
                  value={newPoint.price}
                  onChange={e => setNewPoint({ ...newPoint, price: parseInt(e.target.value) || 1 })}
                  style={{ width: '60px' }}
                />
                <span>%</span>
                <button 
                  className="btn btn-small btn-success"
                  onClick={() => {
                    const price = newPoint.price;
                    if (price < 1 || price > 99) {
                      alert('Price must be 1-99%');
                      return;
                    }
                    if (curvePoints.some(p => p.price === price)) {
                      alert('Point already exists at this price');
                      return;
                    }
                    // Add new point at 0%, then normalize
                    setCurvePoints(prev => {
                      const newPoints = [...prev, { price, weight: 0 }].sort((a, b) => a.price - b.price);
                      return newPoints;
                    });
                  }}
                >
                  + Add
                </button>
              </div>

              {/* SUMMARY */}
              <div className="curve-summary">
                <div className="summary-stat">
                  <label>Total</label>
                  <value className="total-100">{(curvePoints.reduce((s, p) => s + (p.weight || 0), 0) * 100).toFixed(0)}%</value>
                </div>
                <div className="summary-stat">
                  <label>Points</label>
                  <value>{curvePoints.length}</value>
                </div>
                <div className="summary-stat">
                  <label>Active (non-zero)</label>
                  <value>{curvePoints.filter(p => p.weight > 0.005).length}</value>
                </div>
              </div>

              <div className="curve-note">
                <p>
                  💡 Shape is saved as normalized weights. Actual sats = <code>total_liquidity × market_weight × shape_%</code>
                </p>
              </div>

              <div className="curve-actions">
                <button 
                  className="btn btn-success btn-large"
                  onClick={async () => {
                    if (curvePoints.length === 0) {
                      alert('Add at least one point first');
                      return;
                    }
                    const name = prompt('Name for this curve:', `Custom${savedCurves.length + 1}`);
                    if (!name) return;
                    
                    setSaving(true);
                    try {
                      await api.saveShape(name, 'custom', {}, curvePoints);
                      await loadSavedCurves();
                      alert(`Curve saved as "${name}"`);
                    } catch (err) {
                      alert('Failed to save: ' + err.message);
                    }
                    setSaving(false);
                  }}
                  disabled={saving || curvePoints.length === 0}
                >
                  {saving ? 'Saving...' : '💾 Save as Custom'}
                </button>
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

          {/* DEPLOY TAB */}
          {activeTab === 'deploy' && (
            <div className="bot-deploy">
              <h3>🚀 Deployment Preview</h3>
              <p className="deploy-info">
                This shows exactly what orders will be deployed based on your current settings.
                The curve shape is distributed across all markets according to their weights and your total liquidity budget.
              </p>
              
              {loadingPreview ? (
                <div className="loading-preview">Loading preview...</div>
              ) : deploymentPreview ? (
                <>
                  {/* SUMMARY - Now shows full budget calculation */}
                  <div className="deploy-summary">
                    <h4>💰 Budget Calculation</h4>
                    <div className="summary-row">
                      <label>Your Balance:</label>
                      <value>{formatSats(deploymentPreview.user_balance)} sats</value>
                    </div>
                    {deploymentPreview.existing_orders_refund > 0 && (
                      <div className="summary-row">
                        <label>+ Existing Orders Refund:</label>
                        <value className="positive">+{formatSats(deploymentPreview.existing_orders_refund)} sats</value>
                      </div>
                    )}
                    <div className="summary-row highlight">
                      <label>Effective Balance:</label>
                      <value>{formatSats(deploymentPreview.effective_balance)} sats</value>
                    </div>
                    <div className="summary-row">
                      <label>Max Budget (capped at max_loss):</label>
                      <value>{formatSats(deploymentPreview.max_budget)} sats</value>
                    </div>
                    
                    <h4>🔄 Liquidity Formula</h4>
                    <div className="formula-breakdown">
                      <div className="formula-row">
                        <span>Max Budget</span>
                        <span>× {deploymentPreview.config?.global_multiplier || 1}x multiplier</span>
                        <span>= {formatSats(deploymentPreview.displayed_liquidity)} displayed</span>
                      </div>
                      <div className="formula-row">
                        <span>Displayed</span>
                        <span>× {((deploymentPreview.pullback_ratio || 1) * 100).toFixed(1)}% pullback</span>
                        <span>= {formatSats(deploymentPreview.deployable_budget)} deployable</span>
                      </div>
                    </div>
                    
                    {deploymentPreview.current_exposure > 0 && (
                      <div className="exposure-info">
                        <label>Current Exposure:</label>
                        <value>{formatSats(deploymentPreview.current_exposure)} sats ({((deploymentPreview.current_exposure / deploymentPreview.config?.max_acceptable_loss) * 100).toFixed(1)}% of max)</value>
                      </div>
                    )}
                    
                    <h4>📊 Deployment Summary</h4>
                    <div className="summary-row">
                      <label>Total Deployment Cost:</label>
                      <value className={deploymentPreview.has_sufficient_balance ? '' : 'error'}>
                        {formatSats(deploymentPreview.total_cost)} sats
                      </value>
                    </div>
                    <div className="summary-row">
                      <label>Total Orders:</label>
                      <value>{deploymentPreview.total_orders} across {deploymentPreview.total_markets} markets</value>
                    </div>
                    
                    {!deploymentPreview.has_sufficient_balance && (
                      <div className="warning-banner">
                        ⚠️ Insufficient balance! You need {formatSats(deploymentPreview.shortfall)} more sats.
                      </div>
                    )}
                    
                    {deploymentPreview.total_markets === 0 && (
                      <div className="warning-banner">
                        ⚠️ No markets with assigned weights. Click "Initialize from Scores" in Tiers tab first.
                      </div>
                    )}
                    
                    {deploymentPreview.pullback_ratio < 1 && (
                      <div className="info-banner">
                        ℹ️ Pullback active: showing {((deploymentPreview.pullback_ratio || 1) * 100).toFixed(1)}% of full liquidity due to existing exposure.
                      </div>
                    )}
                  </div>
                  
                  {/* AUTO-MATCH WARNING */}
                  {deploymentPreview.auto_matches?.has_auto_matches && (
                    <div className="auto-match-warning">
                      <h4>⚠️ AUTO-MATCH WARNING</h4>
                      <p className="auto-match-intro">
                        These orders will <strong>immediately match</strong> existing YES orders and become locked bets:
                      </p>
                      <div className="auto-match-summary">
                        <div className="match-stat critical">
                          <label>Total Instant Locks:</label>
                          <value>{formatSats(deploymentPreview.auto_matches.total_match_cost)} sats</value>
                        </div>
                        <div className="match-stat">
                          <label>Markets Affected:</label>
                          <value>{deploymentPreview.auto_matches.markets_with_matches}</value>
                        </div>
                        <div className="match-stat">
                          <label>Total Match Amount:</label>
                          <value>{formatSats(deploymentPreview.auto_matches.total_match_amount)} sats</value>
                        </div>
                      </div>
                      
                      <details className="auto-match-details">
                        <summary>📋 View matches by market ({deploymentPreview.auto_matches.markets_with_matches} markets)</summary>
                        <div className="auto-match-markets">
                          {deploymentPreview.auto_matches.matches_by_market?.map((market, i) => (
                            <div key={i} className="auto-match-market">
                              <div className="market-name">{market.grandmaster_name}</div>
                              <table className="mini-table">
                                <thead>
                                  <tr>
                                    <th>Your NO@</th>
                                    <th>Matches YES@</th>
                                    <th>Match Amt</th>
                                    <th>Your Cost</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {market.matches.map((match, j) => (
                                    <tr key={j}>
                                      <td>{match.order_price}%</td>
                                      <td>
                                        {match.matching_orders.map(o => `${o.yes_price}%`).join(', ')}
                                      </td>
                                      <td>{formatSats(match.match_amount)}</td>
                                      <td className="cost">{formatSats(match.match_cost)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr>
                                    <td colSpan="2"><strong>Market Total</strong></td>
                                    <td><strong>{formatSats(market.total_match_amount)}</strong></td>
                                    <td className="cost"><strong>{formatSats(market.total_match_cost)}</strong></td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          ))}
                        </div>
                      </details>
                      
                      <div className="auto-match-impact">
                        <p>
                          💡 <strong>Impact:</strong> {formatSats(deploymentPreview.auto_matches.total_match_cost)} sats will be 
                          immediately converted to active bets (not resting orders). This increases your exposure instantly.
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {/* DEPLOY BUTTON */}
                  <div className="deploy-actions">
                    <button 
                      className="btn btn-primary btn-large"
                      onClick={handleDeployAll}
                      disabled={deploying || !configForm.is_active || !deploymentPreview.has_sufficient_balance || deploymentPreview.total_orders === 0}
                    >
                      {deploying ? 'Deploying...' : `🚀 Deploy ${deploymentPreview.total_orders} Orders to ${deploymentPreview.total_markets} Markets`}
                    </button>
                    <button 
                      className="btn btn-outline"
                      onClick={loadDeploymentPreview}
                    >
                      🔄 Refresh Preview
                    </button>
                  </div>
                  
                  {/* MARKET-BY-MARKET BREAKDOWN */}
                  <details className="deploy-details" open>
                    <summary>📋 Market-by-Market Breakdown ({deploymentPreview.markets?.filter(m => !m.disabled).length} enabled)</summary>
                    <div className="markets-breakdown">
                      {deploymentPreview.markets?.map((market, i) => (
                        <div key={market.market_id} className={`market-preview ${market.disabled ? 'disabled' : ''}`}>
                          <div className="market-header">
                            <span className="gm-name">{market.grandmaster_name || 'Unknown'}</span>
                            <span className="gm-rating">({market.fide_rating})</span>
                            {market.disabled && <span className="status-badge disabled">Disabled</span>}
                          </div>
                          {!market.disabled && market.orders.length > 0 && (
                            <div className="market-orders">
                              <table className="mini-table">
                                <thead>
                                  <tr>
                                    <th>Price</th>
                                    <th>Amount</th>
                                    <th>Cost</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {market.orders.map((order, j) => (
                                    <tr key={j}>
                                      <td>{order.price}%</td>
                                      <td>{formatSats(order.amount)}</td>
                                      <td>{formatSats(order.cost)}</td>
                                    </tr>
                                  ))}
                                  <tr className="total-row">
                                    <td><strong>Total</strong></td>
                                    <td><strong>{formatSats(market.total_amount)}</strong></td>
                                    <td><strong>{formatSats(market.total_cost)}</strong></td>
                                  </tr>
                                </tbody>
                              </table>
                            </div>
                          )}
                          {!market.disabled && market.orders.length === 0 && (
                            <div className="no-orders">No orders (weight too low or no shape)</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                  
                  {/* CONFIG INFO */}
                  <div className="deploy-config">
                    <h4>Current Configuration</h4>
                    <div className="config-summary">
                      <div>Total Liquidity Budget: <strong>{formatSats(deploymentPreview.config?.total_liquidity)} sats</strong></div>
                      <div>Global Multiplier: <strong>{deploymentPreview.config?.global_multiplier}x</strong></div>
                      <div>Bot Status: <strong className={deploymentPreview.config?.is_active ? 'active' : 'inactive'}>
                        {deploymentPreview.config?.is_active ? 'Active' : 'Inactive'}
                      </strong></div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty-preview">
                  <p>Click the button below to load the deployment preview.</p>
                  <button className="btn btn-primary" onClick={loadDeploymentPreview}>
                    Load Preview
                  </button>
                </div>
              )}
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

          {/* TIERS TAB */}
          {activeTab === 'tiers' && (
            <div className="bot-tiers">
              <div className="tiers-header">
                <h3>🎯 Player Tier Budget Allocation</h3>
                <p className="tiers-info">
                  Adjust budget allocation by tier. Players are grouped by likelihood score. 
                  Changing one tier auto-rebalances others to keep total at 100%.
                </p>
                <div className="tier-actions">
                  <button 
                    className="btn btn-primary"
                    onClick={handleInitializeFromScores}
                    disabled={saving}
                  >
                    {saving ? 'Initializing...' : '📊 Initialize from Scores'}
                  </button>
                  <button 
                    className="btn btn-outline"
                    onClick={loadTiers}
                    disabled={loadingTiers}
                  >
                    🔄 Refresh
                  </button>
                </div>
              </div>

              {loadingTiers ? (
                <div className="loading-tiers">Loading tier data...</div>
              ) : tiers.length === 0 ? (
                <div className="empty-tiers">
                  <p>No tier data available. Run the seed-players script first:</p>
                  <code>node backend/seed-players.js</code>
                </div>
              ) : (
                <>
                  {/* TIER VISUALIZATION - Bar Chart */}
                  <div className="tier-chart">
                    {tiers.map(tier => {
                      const percent = parseFloat(tier.budgetPercent) || 0;
                      const barHeight = Math.max(percent * 2, 5); // Min 5px
                      const tierColors = {
                        'S': '#ff6b6b',
                        'A+': '#ff9f43',
                        'A': '#feca57',
                        'B+': '#48dbfb',
                        'B': '#0abde3',
                        'C': '#a55eea',
                        'D': '#8395a7'
                      };
                      
                      return (
                        <div 
                          key={tier.tier}
                          className={`tier-bar-wrapper ${expandedTier === tier.tier ? 'expanded' : ''}`}
                          onClick={() => {
                            if (expandedTier === tier.tier) {
                              setExpandedTier(null);
                            } else {
                              setExpandedTier(tier.tier);
                              if (!tierMarkets[tier.tier]) {
                                loadTierMarkets(tier.tier);
                              }
                            }
                          }}
                        >
                          <div className="tier-bar-label">{tier.tier}</div>
                          <div 
                            className="tier-bar"
                            style={{ 
                              height: `${barHeight}px`,
                              backgroundColor: tierColors[tier.tier] || '#666'
                            }}
                          >
                            <span className="tier-bar-percent">{percent.toFixed(1)}%</span>
                          </div>
                          <div className="tier-bar-count">{tier.marketCount} players</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* TIER TABLE WITH SLIDERS */}
                  <div className="tier-table">
                    <table>
                      <thead>
                        <tr>
                          <th>Tier</th>
                          <th>Budget %</th>
                          <th>Adjustment</th>
                          <th>Markets</th>
                          <th>Sample Players</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tiers.map(tier => (
                          <tr key={tier.tier} className={expandedTier === tier.tier ? 'selected' : ''}>
                            <td className="tier-name">
                              <span className={`tier-badge tier-${tier.tier.replace('+', '-plus')}`}>
                                {tier.tier}
                              </span>
                            </td>
                            <td className="tier-budget">
                              <strong>{parseFloat(tier.budgetPercent).toFixed(1)}%</strong>
                            </td>
                            <td className="tier-slider">
                              <input 
                                type="range"
                                min="0"
                                max="50"
                                step="0.5"
                                value={draggingTier === tier.tier 
                                  ? (localTierValues[tier.tier] !== undefined ? localTierValues[tier.tier] : (parseFloat(tier.budgetPercent) || 0))
                                  : (parseFloat(tier.budgetPercent) || 0)
                                }
                                onChange={e => {
                                  // Update local state only while dragging - don't call API
                                  const newValue = parseFloat(e.target.value);
                                  setDraggingTier(tier.tier);
                                  setLocalTierValues(prev => ({ ...prev, [tier.tier]: newValue }));
                                }}
                                onMouseUp={e => {
                                  // Call API only on release - don't clear local state here!
                                  // The API handler will clear it after response
                                  const newValue = localTierValues[tier.tier];
                                  if (newValue !== undefined) {
                                    handleTierBudgetChange(tier.tier, newValue, true);
                                  } else {
                                    // No change was made, clear state
                                    setDraggingTier(null);
                                    setLocalTierValues({});
                                  }
                                }}
                                onMouseLeave={e => {
                                  // If mouse leaves while dragging, commit the change
                                  if (draggingTier === tier.tier && localTierValues[tier.tier] !== undefined) {
                                    // Let mouseUp handle it if they're still pressing
                                  }
                                }}
                                disabled={saving}
                              />
                              <input 
                                type="number"
                                min="0"
                                max="100"
                                step="0.5"
                                value={draggingTier === tier.tier 
                                  ? (localTierValues[tier.tier] !== undefined ? localTierValues[tier.tier].toFixed(1) : parseFloat(tier.budgetPercent).toFixed(1))
                                  : parseFloat(tier.budgetPercent).toFixed(1)
                                }
                                onChange={e => {
                                  const newValue = parseFloat(e.target.value) || 0;
                                  handleTierBudgetChange(tier.tier, newValue);
                                }}
                                className="tier-input"
                                disabled={saving}
                              />
                              <span>%</span>
                            </td>
                            <td className="tier-markets">{tier.marketCount}</td>
                            <td className="tier-players">
                              {tier.players?.slice(0, 3).join(', ')}
                              {tier.players?.length > 3 && '...'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td><strong>Total</strong></td>
                          <td>
                            <strong className={Math.abs(tiers.reduce((s, t) => s + parseFloat(t.budgetPercent || 0), 0) - 100) < 0.1 ? 'total-ok' : 'total-error'}>
                              {tiers.reduce((s, t) => s + parseFloat(t.budgetPercent || 0), 0).toFixed(1)}%
                            </strong>
                          </td>
                          <td></td>
                          <td><strong>{tiers.reduce((s, t) => s + t.marketCount, 0)}</strong></td>
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* EXPANDED TIER DETAILS */}
                  {expandedTier && (
                    <div className="tier-details">
                      <h4>Tier {expandedTier} Players</h4>
                      {tierMarkets[expandedTier] ? (
                        <div className="tier-players-list">
                          <table className="mini-table">
                            <thead>
                              <tr>
                                <th>Player</th>
                                <th>Rating</th>
                                <th>Score</th>
                                <th>Weight</th>
                              </tr>
                            </thead>
                            <tbody>
                              {tierMarkets[expandedTier].map(m => (
                                <tr key={m.market_id}>
                                  <td>{m.name}</td>
                                  <td>{m.fide_rating || '-'}</td>
                                  <td>{m.likelihood_score || '-'}</td>
                                  <td>{((m.weight || 0) * 100).toFixed(2)}%</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="loading">Loading players...</div>
                      )}
                    </div>
                  )}

                  {/* TIER LEGEND */}
                  <div className="tier-legend">
                    <h4>Tier Definitions</h4>
                    <div className="legend-items">
                      <div className="legend-item"><span className="tier-badge tier-S">S</span> Score 70+ (Most Likely)</div>
                      <div className="legend-item"><span className="tier-badge tier-A-plus">A+</span> Score 60-69 (Very Likely)</div>
                      <div className="legend-item"><span className="tier-badge tier-A">A</span> Score 50-59 (Likely)</div>
                      <div className="legend-item"><span className="tier-badge tier-B-plus">B+</span> Score 40-49 (Above Average)</div>
                      <div className="legend-item"><span className="tier-badge tier-B">B</span> Score 25-39 (Average)</div>
                      <div className="legend-item"><span className="tier-badge tier-C">C</span> Score 0-24 (Below Average)</div>
                      <div className="legend-item"><span className="tier-badge tier-D">D</span> Score &lt;0 (Unlikely)</div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* WITHDRAWALS TAB */}
          {activeTab === 'withdrawals' && (
            <div className="bot-withdrawals">
              <h3>💸 Pending Withdrawals ({pendingWithdrawals.length + pendingOnchainWithdrawals.length})</h3>
              
              {/* Compact Balance Overview */}
              <div className="withdrawal-balance-grid">
                <div className="balance-box lightning">
                  <span className="balance-icon">⚡</span>
                  <div className="balance-content">
                    <span className="balance-label">Lightning</span>
                    <span className="balance-values">
                      <span className="outbound">↑ {formatSats(channelBalance?.outbound_sats || 0)}</span>
                      <span className="inbound">↓ {formatSats(channelBalance?.inbound_sats || 0)}</span>
                    </span>
                  </div>
                </div>
                <div className="balance-box onchain">
                  <span className="balance-icon">⛓️</span>
                  <div className="balance-content">
                    <span className="balance-label">On-Chain</span>
                    <span className="balance-value">{formatSats(onchainBalance?.balance_sats || 0)}</span>
                  </div>
                </div>
                {channelBalance && !channelBalance.is_real && (
                  <div className="balance-box mock">
                    <span>⚠️ Mock Mode</span>
                  </div>
                )}
              </div>
              
              {loadingWithdrawals ? (
                <div className="loading">Loading withdrawals...</div>
              ) : (pendingWithdrawals.length === 0 && pendingOnchainWithdrawals.length === 0) ? (
                <div className="empty-state">
                  <p>✅ No pending withdrawals</p>
                </div>
              ) : (
                <div className="withdrawals-list-compact">
                  {/* LIGHTNING WITHDRAWALS */}
                  {pendingWithdrawals.map(pw => {
                    const isExpanded = expandedWithdrawal === `ln-${pw.id}`;
                    const hasLiquidity = !channelBalance || channelBalance.outbound_sats >= pw.amount_sats;
                    return (
                      <div key={`ln-${pw.id}`} className={`withdrawal-row ${isExpanded ? 'expanded' : ''} ${!hasLiquidity ? 'low-liquidity' : ''}`}>
                        <div className="withdrawal-summary" onClick={() => setExpandedWithdrawal(isExpanded ? null : `ln-${pw.id}`)}>
                          <span className="w-type lightning">⚡</span>
                          <span className="w-user">{pw.username || pw.email?.split('@')[0] || 'User'}</span>
                          <span className="w-amount">{formatSats(pw.amount_sats)} sats</span>
                          <span className="w-expand">{isExpanded ? '▲' : '▼'}</span>
                          <div className="w-actions" onClick={e => e.stopPropagation()}>
                            <button 
                              className="btn btn-sm btn-approve"
                              onClick={async () => {
                                if (!confirm(`Approve ${formatSats(pw.amount_sats)} sats to ${pw.username || pw.email}?`)) return;
                                setProcessingWithdrawal(pw.id);
                                try {
                                  await api.approveWithdrawal(pw.id);
                                  const [withdrawals, balance] = await Promise.all([
                                    api.getAdminPendingWithdrawals(),
                                    api.getChannelBalance()
                                  ]);
                                  setPendingWithdrawals(withdrawals || []);
                                  setChannelBalance(balance);
                                } catch (err) {
                                  alert('Failed: ' + err.message);
                                }
                                setProcessingWithdrawal(null);
                              }}
                              disabled={processingWithdrawal === pw.id || !hasLiquidity}
                            >
                              {processingWithdrawal === pw.id ? '...' : '✓'}
                            </button>
                            <button 
                              className="btn btn-sm btn-reject"
                              onClick={async () => {
                                const reason = prompt('Reason (optional):');
                                if (reason === null) return;
                                setProcessingWithdrawal(pw.id);
                                try {
                                  await api.rejectWithdrawal(pw.id, reason || 'Rejected');
                                  const withdrawals = await api.getAdminPendingWithdrawals();
                                  setPendingWithdrawals(withdrawals || []);
                                } catch (err) {
                                  alert('Failed: ' + err.message);
                                }
                                setProcessingWithdrawal(null);
                              }}
                              disabled={processingWithdrawal === pw.id}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="withdrawal-expanded">
                            <div className="w-detail"><label>Requested:</label> {new Date(pw.created_at).toLocaleString()}</div>
                            <div className="w-detail"><label>User Deposits:</label> {formatSats(pw.user_total_deposits)} sats</div>
                            <div className="w-detail invoice"><label>Invoice:</label> <code>{pw.payment_request}</code></div>
                            {!hasLiquidity && (
                              <div className="w-warning">⚠️ Insufficient liquidity ({formatSats(channelBalance?.outbound_sats || 0)} available)</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  
                  {/* ON-CHAIN WITHDRAWALS */}
                  {pendingOnchainWithdrawals.map(pw => {
                    const isExpanded = expandedWithdrawal === `oc-${pw.id}`;
                    return (
                      <div key={`oc-${pw.id}`} className={`withdrawal-row ${isExpanded ? 'expanded' : ''}`}>
                        <div className="withdrawal-summary" onClick={() => setExpandedWithdrawal(isExpanded ? null : `oc-${pw.id}`)}>
                          <span className="w-type onchain">⛓️</span>
                          <span className="w-user">{pw.username || pw.email?.split('@')[0] || 'User'}</span>
                          <span className="w-amount">{formatSats(pw.amount_sats)} sats</span>
                          <span className="w-expand">{isExpanded ? '▲' : '▼'}</span>
                          <div className="w-actions" onClick={e => e.stopPropagation()}>
                            <button 
                              className="btn btn-sm btn-approve"
                              onClick={async () => {
                                if (!confirm(`Approve ${formatSats(pw.amount_sats)} sats to ${pw.dest_address}?`)) return;
                                setProcessingWithdrawal(pw.id);
                                try {
                                  await api.approveOnchainWithdrawal(pw.id);
                                  const [onchainWithdrawals, onchainBal] = await Promise.all([
                                    api.getAdminOnchainPendingWithdrawals(),
                                    api.getOnchainBalance().catch(() => null)
                                  ]);
                                  setPendingOnchainWithdrawals(onchainWithdrawals || []);
                                  setOnchainBalance(onchainBal);
                                } catch (err) {
                                  alert('Failed: ' + err.message);
                                }
                                setProcessingWithdrawal(null);
                              }}
                              disabled={processingWithdrawal === pw.id}
                            >
                              {processingWithdrawal === pw.id ? '...' : '✓'}
                            </button>
                            <button 
                              className="btn btn-sm btn-reject"
                              onClick={async () => {
                                const reason = prompt('Reason (optional):');
                                if (reason === null) return;
                                setProcessingWithdrawal(pw.id);
                                try {
                                  await api.rejectOnchainWithdrawal(pw.id, reason || 'Rejected');
                                  const onchainWithdrawals = await api.getAdminOnchainPendingWithdrawals();
                                  setPendingOnchainWithdrawals(onchainWithdrawals || []);
                                } catch (err) {
                                  alert('Failed: ' + err.message);
                                }
                                setProcessingWithdrawal(null);
                              }}
                              disabled={processingWithdrawal === pw.id}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div className="withdrawal-expanded">
                            <div className="w-detail"><label>Requested:</label> {new Date(pw.created_at).toLocaleString()}</div>
                            <div className="w-detail"><label>User Deposits:</label> {formatSats(pw.user_total_onchain_deposits)} sats</div>
                            <div className="w-detail"><label>Fee:</label> {pw.user_pays_fee ? 'User pays' : 'Platform (free)'}</div>
                            <div className="w-detail address"><label>Address:</label> <code>{pw.dest_address}</code></div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              
              <button 
                className="btn btn-outline"
                onClick={async () => {
                  setLoadingWithdrawals(true);
                  try {
                    const [withdrawals, balance, onchainWithdrawals, onchainBal] = await Promise.all([
                      api.getAdminPendingWithdrawals(),
                      api.getChannelBalance(),
                      api.getAdminOnchainPendingWithdrawals(),
                      api.getOnchainBalance().catch(() => null)
                    ]);
                    setPendingWithdrawals(withdrawals || []);
                    setChannelBalance(balance);
                    setPendingOnchainWithdrawals(onchainWithdrawals || []);
                    setOnchainBalance(onchainBal);
                  } catch (err) {
                    console.error('Failed to refresh:', err);
                  }
                  setLoadingWithdrawals(false);
                }}
                style={{ marginTop: '1rem' }}
              >
                🔄 Refresh
              </button>
            </div>
          )}

          {/* RECONCILIATION TAB */}
          {activeTab === 'reconciliation' && (
            <div className="bot-reconciliation">
              <h3>🔍 Deposit/Withdrawal Reconciliation</h3>
              <p className="reconciliation-info">
                Compare database records against LN node and blockchain data to ensure everything matches.
              </p>
              
              {loadingReconciliation ? (
                <div className="loading">Loading reconciliation data...</div>
              ) : reconciliationData ? (
                <>
                  {/* SOLVENCY OVERVIEW */}
                  <div className={`solvency-panel ${reconciliationData.reconciliation?.is_solvent ? 'solvent' : 'insolvent'}`}>
                    <h4>{reconciliationData.reconciliation?.is_solvent ? '✅ SOLVENT' : '⚠️ ATTENTION NEEDED'}</h4>
                    <div className="solvency-grid">
                      <div className="solvency-stat">
                        <label>Total User Balances</label>
                        <value>{formatSats(reconciliationData.reconciliation?.total_user_balances)} sats</value>
                      </div>
                      <div className="solvency-stat">
                        <label>Pending Withdrawals</label>
                        <value>{formatSats(reconciliationData.reconciliation?.total_pending_withdrawals)} sats</value>
                      </div>
                      <div className="solvency-stat">
                        <label>Total Node Balance</label>
                        <value>{formatSats(reconciliationData.reconciliation?.total_node_balance)} sats</value>
                      </div>
                    </div>
                    {!reconciliationData.is_real_node && (
                      <div className="mock-warning">⚠️ Mock Node Mode - Data not from real LN node</div>
                    )}
                  </div>

                  {/* SUB-NAVIGATION */}
                  <div className="reconciliation-tabs">
                    <button 
                      className={reconciliationView === 'overview' ? 'active' : ''}
                      onClick={() => setReconciliationView('overview')}
                    >
                      Overview
                    </button>
                    <button 
                      className={reconciliationView === 'ln-deposits' ? 'active' : ''}
                      onClick={async () => {
                        setReconciliationView('ln-deposits');
                        if (!matchData?.lnDeposits) {
                          try {
                            const data = await api.matchDeposits();
                            setMatchData(prev => ({ ...prev, lnDeposits: data }));
                          } catch (err) {
                            console.error('Failed to load LN deposits:', err);
                          }
                        }
                      }}
                    >
                      ⚡ LN Deposits
                    </button>
                    <button 
                      className={reconciliationView === 'ln-withdrawals' ? 'active' : ''}
                      onClick={async () => {
                        setReconciliationView('ln-withdrawals');
                        if (!matchData?.lnWithdrawals) {
                          try {
                            const data = await api.matchWithdrawals();
                            setMatchData(prev => ({ ...prev, lnWithdrawals: data }));
                          } catch (err) {
                            console.error('Failed to load LN withdrawals:', err);
                          }
                        }
                      }}
                    >
                      ⚡ LN Withdrawals
                    </button>
                    <button 
                      className={reconciliationView === 'onchain-deposits' ? 'active' : ''}
                      onClick={async () => {
                        setReconciliationView('onchain-deposits');
                        if (!matchData?.onchainDeposits) {
                          try {
                            const data = await api.matchOnchainDeposits();
                            setMatchData(prev => ({ ...prev, onchainDeposits: data }));
                          } catch (err) {
                            console.error('Failed to load on-chain deposits:', err);
                          }
                        }
                      }}
                    >
                      ⛓️ On-Chain Deposits
                    </button>
                    <button 
                      className={reconciliationView === 'onchain-withdrawals' ? 'active' : ''}
                      onClick={async () => {
                        setReconciliationView('onchain-withdrawals');
                        if (!matchData?.onchainWithdrawals) {
                          try {
                            const data = await api.matchOnchainWithdrawals();
                            setMatchData(prev => ({ ...prev, onchainWithdrawals: data }));
                          } catch (err) {
                            console.error('Failed to load on-chain withdrawals:', err);
                          }
                        }
                      }}
                    >
                      ⛓️ On-Chain Withdrawals
                    </button>
                  </div>

                  {/* OVERVIEW VIEW */}
                  {reconciliationView === 'overview' && (
                    <div className="reconciliation-overview">
                      <div className="reconciliation-columns">
                        {/* DATABASE VIEW */}
                        <div className="recon-column database">
                          <h4>📊 Database View</h4>
                          <div className="recon-stats">
                            <div className="stat-group">
                              <h5>⚡ Lightning</h5>
                              <div><label>Deposits Credited:</label> {formatSats(reconciliationData.database?.totals?.total_ln_deposits)} sats</div>
                              <div><label>Withdrawals Completed:</label> {formatSats(reconciliationData.database?.totals?.total_ln_withdrawals)} sats</div>
                              <div><label>Pending Withdrawals:</label> {formatSats(reconciliationData.database?.totals?.total_ln_pending)} sats</div>
                            </div>
                            <div className="stat-group">
                              <h5>⛓️ On-Chain</h5>
                              <div><label>Deposits Credited:</label> {formatSats(reconciliationData.database?.totals?.total_onchain_deposits_credited)} sats</div>
                              <div><label>Withdrawals Completed:</label> {formatSats(reconciliationData.database?.totals?.total_onchain_withdrawals_completed)} sats</div>
                              <div><label>Pending Withdrawals:</label> {formatSats(reconciliationData.database?.totals?.total_onchain_pending)} sats</div>
                            </div>
                          </div>
                        </div>

                        {/* NODE VIEW */}
                        <div className="recon-column node">
                          <h4>🔌 Node View</h4>
                          <div className="recon-stats">
                            <div className="stat-group">
                              <h5>⚡ Lightning Channels</h5>
                              <div><label>Outbound (Can Send):</label> {formatSats(reconciliationData.node?.channel_balance?.outbound_sats)} sats</div>
                              <div><label>Inbound (Can Receive):</label> {formatSats(reconciliationData.node?.channel_balance?.inbound_sats)} sats</div>
                              <div><label>Active Channels:</label> {reconciliationData.node?.channel_balance?.active_channels || 0}</div>
                            </div>
                            <div className="stat-group">
                              <h5>⛓️ On-Chain Wallet</h5>
                              <div><label>Confirmed:</label> {formatSats(reconciliationData.node?.onchain_balance?.confirmed_sats)} sats</div>
                              <div><label>Unconfirmed:</label> {formatSats(reconciliationData.node?.onchain_balance?.unconfirmed_sats)} sats</div>
                              <div><label>Incoming Total:</label> {formatSats(reconciliationData.node?.totals?.onchain_incoming)} sats</div>
                              <div><label>Outgoing Total:</label> {formatSats(reconciliationData.node?.totals?.onchain_outgoing)} sats</div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* NODE INFO */}
                      {reconciliationData.node?.info && (
                        <div className="node-info-panel">
                          <h5>Node Info</h5>
                          <div><label>Alias:</label> {reconciliationData.node.info.alias || 'Unknown'}</div>
                          <div><label>Pubkey:</label> <code>{reconciliationData.node.info.pubkey?.substring(0, 20)}...</code></div>
                          <div><label>Network:</label> {reconciliationData.node.info.network || 'Unknown'}</div>
                          <div><label>Real Node:</label> {reconciliationData.node.info.is_real ? '✅ Yes' : '❌ Mock'}</div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* LN DEPOSITS VIEW */}
                  {reconciliationView === 'ln-deposits' && matchData?.lnDeposits && (
                    <div className="match-view">
                      <h4>⚡ Lightning Deposit Matching</h4>
                      <div className="match-summary">
                        <span className="match-stat matched">✅ Matched: {matchData.lnDeposits.summary?.matched || 0}</span>
                        <span className="match-stat pending">⏳ Pending: {matchData.lnDeposits.summary?.both_pending || 0}</span>
                        <span className="match-stat mismatch">⚠️ Amount Mismatch: {matchData.lnDeposits.summary?.amount_mismatch || 0}</span>
                        <span className="match-stat error">❌ DB Paid, Node Not: {matchData.lnDeposits.summary?.db_says_paid_node_says_no || 0}</span>
                        <span className="match-stat warning">🔍 Node Paid, DB Pending: {matchData.lnDeposits.summary?.node_says_paid_db_pending || 0}</span>
                        <span className="match-stat no-data">⬜ No Node Data: {matchData.lnDeposits.summary?.no_node_data || 0}</span>
                      </div>
                      <div className="match-table-wrapper">
                        <table className="match-table">
                          <thead>
                            <tr>
                              <th>User</th>
                              <th>DB Amount</th>
                              <th>DB Status</th>
                              <th>Node Settled</th>
                              <th>Node Amount</th>
                              <th>Match Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {matchData.lnDeposits.deposits?.slice(0, 50).map((d, i) => (
                              <tr key={i} className={`match-${d.match_status}`}>
                                <td>{d.username || d.email || 'Unknown'}</td>
                                <td>{formatSats(d.amount_sats)}</td>
                                <td>{d.status}</td>
                                <td>{d.node_invoice ? (d.node_invoice.settled ? '✅' : '❌') : '-'}</td>
                                <td>{d.node_invoice ? formatSats(d.node_invoice.amount_paid_sats) : '-'}</td>
                                <td className={`status-${d.match_status}`}>
                                  {d.match_status === 'matched' && '✅ Matched'}
                                  {d.match_status === 'amount_mismatch' && '⚠️ Mismatch'}
                                  {d.match_status === 'db_says_paid_node_says_no' && '❌ DB Error?'}
                                  {d.match_status === 'node_says_paid_db_pending' && '🔍 Credit Needed?'}
                                  {d.match_status === 'both_pending' && '⏳ Pending'}
                                  {d.match_status === 'no_node_data' && '⬜ No Node Data'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* LN WITHDRAWALS VIEW */}
                  {reconciliationView === 'ln-withdrawals' && matchData?.lnWithdrawals && (
                    <div className="match-view">
                      <h4>⚡ Lightning Withdrawal Matching</h4>
                      <div className="match-summary">
                        <span className="match-stat matched">✅ Matched: {matchData.lnWithdrawals.summary?.matched || 0}</span>
                        <span className="match-stat pending">⏳ Pending: {matchData.lnWithdrawals.summary?.pending_in_db || 0}</span>
                        <span className="match-stat mismatch">⚠️ Amount Mismatch: {matchData.lnWithdrawals.summary?.amount_mismatch || 0}</span>
                        <span className="match-stat error">❌ DB Complete, Node Failed: {matchData.lnWithdrawals.summary?.db_says_completed_node_says_no || 0}</span>
                        <span className="match-stat no-data">⬜ No Node Data: {matchData.lnWithdrawals.summary?.no_node_data || 0}</span>
                      </div>
                      <div className="match-table-wrapper">
                        <table className="match-table">
                          <thead>
                            <tr>
                              <th>User</th>
                              <th>DB Amount</th>
                              <th>DB Status</th>
                              <th>Node Status</th>
                              <th>Node Amount</th>
                              <th>Match Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {matchData.lnWithdrawals.withdrawals?.slice(0, 50).map((w, i) => (
                              <tr key={i} className={`match-${w.match_status}`}>
                                <td>{w.username || w.email || 'Unknown'}</td>
                                <td>{formatSats(w.amount_sats)}</td>
                                <td>{w.status}</td>
                                <td>{w.node_payment?.status || '-'}</td>
                                <td>{w.node_payment ? formatSats(w.node_payment.amount_sats) : '-'}</td>
                                <td className={`status-${w.match_status}`}>
                                  {w.match_status === 'matched' && '✅ Matched'}
                                  {w.match_status === 'amount_mismatch' && '⚠️ Mismatch'}
                                  {w.match_status === 'db_says_completed_node_says_no' && '❌ DB Error?'}
                                  {w.match_status === 'pending_in_db' && '⏳ Pending'}
                                  {w.match_status === 'no_node_data' && '⬜ No Node Data'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ON-CHAIN DEPOSITS VIEW */}
                  {reconciliationView === 'onchain-deposits' && matchData?.onchainDeposits && (
                    <div className="match-view">
                      <h4>⛓️ On-Chain Deposit Matching</h4>
                      <div className="match-summary">
                        <span className="match-stat matched">✅ Matched: {matchData.onchainDeposits.summary?.matched || 0}</span>
                        <span className="match-stat pending">⏳ Awaiting: {matchData.onchainDeposits.summary?.awaiting_deposit || 0}</span>
                        <span className="match-stat warning">🔄 Pending Conf: {matchData.onchainDeposits.summary?.pending_confirmation || 0}</span>
                        <span className="match-stat error">❌ Node Confirmed, DB Not: {matchData.onchainDeposits.summary?.node_confirmed_db_not_credited || 0}</span>
                        <span className="match-stat mismatch">⚠️ Amount Mismatch: {matchData.onchainDeposits.summary?.amount_mismatch || 0}</span>
                      </div>
                      <div className="match-table-wrapper">
                        <table className="match-table">
                          <thead>
                            <tr>
                              <th>User</th>
                              <th>Address</th>
                              <th>DB Amount</th>
                              <th>DB Credited</th>
                              <th>Node Confs</th>
                              <th>Match Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {matchData.onchainDeposits.deposits?.slice(0, 50).map((d, i) => (
                              <tr key={i} className={`match-${d.match_status}`}>
                                <td>{d.username || d.email || 'Unknown'}</td>
                                <td><code>{d.address?.substring(0, 12)}...</code></td>
                                <td>{formatSats(d.amount_sats)}</td>
                                <td>{d.credited ? '✅' : '❌'}</td>
                                <td>{d.node_tx?.confirmations ?? '-'}</td>
                                <td className={`status-${d.match_status}`}>
                                  {d.match_status === 'matched' && '✅ Matched'}
                                  {d.match_status === 'awaiting_deposit' && '⏳ Awaiting'}
                                  {d.match_status === 'pending_confirmation' && '🔄 Confirming'}
                                  {d.match_status === 'node_confirmed_db_not_credited' && '❌ Credit Needed!'}
                                  {d.match_status === 'amount_mismatch' && '⚠️ Mismatch'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ON-CHAIN WITHDRAWALS VIEW */}
                  {reconciliationView === 'onchain-withdrawals' && matchData?.onchainWithdrawals && (
                    <div className="match-view">
                      <h4>⛓️ On-Chain Withdrawal Matching</h4>
                      <div className="match-summary">
                        <span className="match-stat matched">✅ Matched: {matchData.onchainWithdrawals.summary?.matched || 0}</span>
                        <span className="match-stat pending">⏳ Pending: {matchData.onchainWithdrawals.summary?.pending_approval || 0}</span>
                        <span className="match-stat rejected">🚫 Rejected: {matchData.onchainWithdrawals.summary?.rejected || 0}</span>
                        <span className="match-stat mismatch">⚠️ Amount Mismatch: {matchData.onchainWithdrawals.summary?.amount_mismatch || 0}</span>
                        <span className="match-stat error">❌ TXID Not Found: {matchData.onchainWithdrawals.summary?.db_completed_txid_not_on_node || 0}</span>
                      </div>
                      <div className="match-table-wrapper">
                        <table className="match-table">
                          <thead>
                            <tr>
                              <th>User</th>
                              <th>Address</th>
                              <th>DB Amount</th>
                              <th>DB Status</th>
                              <th>TXID</th>
                              <th>Match Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {matchData.onchainWithdrawals.withdrawals?.slice(0, 50).map((w, i) => (
                              <tr key={i} className={`match-${w.match_status}`}>
                                <td>{w.username || w.email || 'Unknown'}</td>
                                <td><code>{w.dest_address?.substring(0, 12)}...</code></td>
                                <td>{formatSats(w.amount_sats)}</td>
                                <td>{w.status}</td>
                                <td>{w.txid ? <code>{w.txid.substring(0, 10)}...</code> : '-'}</td>
                                <td className={`status-${w.match_status}`}>
                                  {w.match_status === 'matched' && '✅ Matched'}
                                  {w.match_status === 'pending_approval' && '⏳ Pending'}
                                  {w.match_status === 'rejected' && '🚫 Rejected'}
                                  {w.match_status === 'amount_mismatch' && '⚠️ Mismatch'}
                                  {w.match_status === 'db_completed_txid_not_on_node' && '❌ TXID Missing'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <button 
                    className="btn btn-outline"
                    onClick={async () => {
                      setLoadingReconciliation(true);
                      setMatchData(null);
                      try {
                        const data = await api.getReconciliationOverview();
                        setReconciliationData(data);
                      } catch (err) {
                        console.error('Failed to refresh:', err);
                      }
                      setLoadingReconciliation(false);
                    }}
                    style={{ marginTop: '1rem' }}
                  >
                    🔄 Refresh All
                  </button>
                </>
              ) : (
                <div className="empty-state">
                  <p>Click the Reconciliation tab to load data.</p>
                </div>
              )}
            </div>
          )}

          {/* PULLBACK THRESHOLDS TAB */}
          {activeTab === 'pullback' && (
            <div className="bot-pullback">
              <h3>📊 Pullback Thresholds</h3>
              <p className="pullback-info">
                Configure how liquidity is reduced as exposure increases. The bot automatically 
                pulls back offers based on these thresholds to protect against max loss.
              </p>
              
              {loadingPullback ? (
                <div className="loading">Loading pullback data...</div>
              ) : (
                <>
                  {/* CURRENT STATUS */}
                  {pullbackStatus && (
                    <div className="pullback-status-panel">
                      <h4>Current Status</h4>
                      <div className="status-grid">
                        <div className="status-item">
                          <label>Current Exposure</label>
                          <value>{formatSats(pullbackStatus.current_exposure)} sats</value>
                          <span>({pullbackStatus.exposure_percent?.toFixed(1)}% of max)</span>
                        </div>
                        <div className="status-item">
                          <label>Pullback Ratio</label>
                          <value>{((pullbackStatus.pullback_ratio || 1) * 100).toFixed(1)}%</value>
                          <span>liquidity multiplier</span>
                        </div>
                        <div className="status-item">
                          <label>Max Loss</label>
                          <value>{formatSats(pullbackStatus.max_loss)} sats</value>
                        </div>
                        <div className="status-item">
                          <label>Active Threshold</label>
                          <value>
                            {pullbackStatus.active_threshold 
                              ? `${pullbackStatus.active_threshold.exposure_percent}% → ${pullbackStatus.active_threshold.pullback_percent}%`
                              : 'None (full liquidity)'}
                          </value>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* THRESHOLD VISUALIZATION */}
                  <div className="threshold-chart">
                    <h4>Threshold Curve</h4>
                    <div className="chart-container">
                      <div className="chart-y-axis">
                        <span>100%</span>
                        <span>75%</span>
                        <span>50%</span>
                        <span>25%</span>
                        <span>0%</span>
                      </div>
                      <div className="chart-canvas">
                        {/* Background grid */}
                        <div className="chart-grid">
                          {[0, 25, 50, 75, 100].map(y => (
                            <div key={y} className="grid-line horizontal" style={{ bottom: `${y}%` }} />
                          ))}
                          {[0, 25, 50, 75, 100].map(x => (
                            <div key={x} className="grid-line vertical" style={{ left: `${x}%` }} />
                          ))}
                        </div>
                        
                        {/* Threshold points and lines */}
                        <svg className="threshold-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
                          {/* Draw the pullback curve */}
                          <path 
                            d={(() => {
                              const sortedThresholds = [...thresholds].sort((a, b) => a.exposure_percent - b.exposure_percent);
                              if (sortedThresholds.length === 0) {
                                // Linear default: 100% at 0 exposure, 0% at 100 exposure
                                return 'M 0 0 L 100 100';
                              }
                              let path = 'M 0 ' + (100 - (sortedThresholds[0]?.pullback_percent || 100));
                              sortedThresholds.forEach(t => {
                                path += ` L ${t.exposure_percent} ${100 - t.pullback_percent}`;
                              });
                              // Extend to 100% exposure at 0% pullback if not already there
                              const last = sortedThresholds[sortedThresholds.length - 1];
                              if (last && last.exposure_percent < 100) {
                                path += ` L 100 100`;
                              }
                              return path;
                            })()}
                            fill="none"
                            stroke="#f39c12"
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                          />
                          
                          {/* Draw points */}
                          {thresholds.map((t, i) => (
                            <circle
                              key={i}
                              cx={t.exposure_percent}
                              cy={100 - t.pullback_percent}
                              r="4"
                              fill="#f39c12"
                              stroke="#fff"
                              strokeWidth="1"
                              vectorEffect="non-scaling-stroke"
                            />
                          ))}
                          
                          {/* Current position indicator */}
                          {pullbackStatus && (
                            <circle
                              cx={pullbackStatus.exposure_percent || 0}
                              cy={100 - ((pullbackStatus.pullback_ratio || 1) * 100)}
                              r="6"
                              fill="#e74c3c"
                              stroke="#fff"
                              strokeWidth="2"
                              vectorEffect="non-scaling-stroke"
                            />
                          )}
                        </svg>
                        
                        {/* Current position label */}
                        {pullbackStatus && (
                          <div 
                            className="current-marker"
                            style={{ 
                              left: `${pullbackStatus.exposure_percent || 0}%`,
                              bottom: `${(pullbackStatus.pullback_ratio || 1) * 100}%`
                            }}
                          >
                            <span className="marker-label">YOU</span>
                          </div>
                        )}
                      </div>
                      <div className="chart-x-axis">
                        <span>0%</span>
                        <span>25%</span>
                        <span>50%</span>
                        <span>75%</span>
                        <span>100%</span>
                      </div>
                      <div className="axis-labels">
                        <span className="y-label">Liquidity %</span>
                        <span className="x-label">Exposure %</span>
                      </div>
                    </div>
                  </div>

                  {/* THRESHOLD TABLE */}
                  <div className="threshold-table">
                    <h4>Thresholds ({thresholds.length})</h4>
                    <table>
                      <thead>
                        <tr>
                          <th>Exposure %</th>
                          <th>Pullback (Liquidity %)</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {thresholds.sort((a, b) => a.exposure_percent - b.exposure_percent).map((t, i) => (
                          <tr key={i} className={pullbackStatus?.active_threshold?.exposure_percent === t.exposure_percent ? 'active' : ''}>
                            <td>
                              <input 
                                type="number" 
                                min="0" 
                                max="100" 
                                step="5"
                                value={t.exposure_percent}
                                onChange={async (e) => {
                                  const newExposure = parseFloat(e.target.value) || 0;
                                  setSaving(true);
                                  try {
                                    // Remove old, add new
                                    await api.removeThreshold(t.exposure_percent);
                                    const result = await api.setThreshold(newExposure, t.pullback_percent);
                                    setThresholds(result.thresholds || []);
                                  } catch (err) {
                                    alert('Failed to update: ' + err.message);
                                  }
                                  setSaving(false);
                                }}
                                disabled={saving}
                              />
                              <span>%</span>
                            </td>
                            <td>
                              <input 
                                type="number" 
                                min="0" 
                                max="100" 
                                step="5"
                                value={t.pullback_percent}
                                onChange={async (e) => {
                                  const newPullback = parseFloat(e.target.value) || 0;
                                  setSaving(true);
                                  try {
                                    const result = await api.setThreshold(t.exposure_percent, newPullback);
                                    setThresholds(result.thresholds || []);
                                  } catch (err) {
                                    alert('Failed to update: ' + err.message);
                                  }
                                  setSaving(false);
                                }}
                                disabled={saving}
                              />
                              <span>%</span>
                            </td>
                            <td>
                              <button 
                                className="btn btn-sm btn-danger"
                                onClick={async () => {
                                  if (thresholds.length <= 1) {
                                    alert('Must have at least one threshold');
                                    return;
                                  }
                                  setSaving(true);
                                  try {
                                    const result = await api.removeThreshold(t.exposure_percent);
                                    setThresholds(result.thresholds || []);
                                  } catch (err) {
                                    alert('Failed to remove: ' + err.message);
                                  }
                                  setSaving(false);
                                }}
                                disabled={saving}
                              >
                                🗑️
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* ADD NEW THRESHOLD */}
                  <div className="add-threshold">
                    <h4>Add Threshold</h4>
                    <div className="add-threshold-form">
                      <label>
                        At Exposure:
                        <input 
                          type="number" 
                          min="0" 
                          max="100" 
                          step="5"
                          value={newThreshold.exposure}
                          onChange={e => setNewThreshold({ ...newThreshold, exposure: parseFloat(e.target.value) || 0 })}
                        />
                        <span>%</span>
                      </label>
                      <label>
                        Pullback to:
                        <input 
                          type="number" 
                          min="0" 
                          max="100" 
                          step="5"
                          value={newThreshold.pullback}
                          onChange={e => setNewThreshold({ ...newThreshold, pullback: parseFloat(e.target.value) || 0 })}
                        />
                        <span>%</span>
                      </label>
                      <button 
                        className="btn btn-success"
                        onClick={async () => {
                          if (thresholds.some(t => t.exposure_percent === newThreshold.exposure)) {
                            alert('Threshold at this exposure already exists');
                            return;
                          }
                          setSaving(true);
                          try {
                            const result = await api.setThreshold(newThreshold.exposure, newThreshold.pullback);
                            setThresholds(result.thresholds || []);
                            // Auto-increment for next one
                            setNewThreshold({ 
                              exposure: Math.min(newThreshold.exposure + 10, 100), 
                              pullback: Math.max(newThreshold.pullback - 10, 0) 
                            });
                          } catch (err) {
                            alert('Failed to add: ' + err.message);
                          }
                          setSaving(false);
                        }}
                        disabled={saving}
                      >
                        {saving ? 'Adding...' : '+ Add Threshold'}
                      </button>
                    </div>
                  </div>

                  {/* PRESETS */}
                  <div className="threshold-presets">
                    <h4>Presets</h4>
                    <div className="preset-buttons">
                      <button 
                        className="btn btn-outline"
                        onClick={async () => {
                          if (!confirm('Reset to default linear thresholds?')) return;
                          setSaving(true);
                          try {
                            const result = await api.resetThresholds();
                            setThresholds(result.thresholds || []);
                          } catch (err) {
                            alert('Failed to reset: ' + err.message);
                          }
                          setSaving(false);
                        }}
                        disabled={saving}
                      >
                        🔄 Reset to Defaults
                      </button>
                      <button 
                        className="btn btn-outline"
                        onClick={async () => {
                          // Aggressive: quick pullback
                          const aggressive = [
                            { exposure_percent: 10, pullback_percent: 80 },
                            { exposure_percent: 25, pullback_percent: 50 },
                            { exposure_percent: 50, pullback_percent: 25 },
                            { exposure_percent: 75, pullback_percent: 10 },
                            { exposure_percent: 90, pullback_percent: 0 },
                          ];
                          if (!confirm('Apply aggressive preset? (faster pullback)')) return;
                          setSaving(true);
                          try {
                            const result = await api.setAllThresholds(aggressive);
                            setThresholds(result.thresholds || []);
                          } catch (err) {
                            alert('Failed: ' + err.message);
                          }
                          setSaving(false);
                        }}
                        disabled={saving}
                      >
                        ⚡ Aggressive
                      </button>
                      <button 
                        className="btn btn-outline"
                        onClick={async () => {
                          // Conservative: slower pullback
                          const conservative = [
                            { exposure_percent: 25, pullback_percent: 90 },
                            { exposure_percent: 50, pullback_percent: 75 },
                            { exposure_percent: 75, pullback_percent: 50 },
                            { exposure_percent: 90, pullback_percent: 25 },
                            { exposure_percent: 100, pullback_percent: 0 },
                          ];
                          if (!confirm('Apply conservative preset? (slower pullback)')) return;
                          setSaving(true);
                          try {
                            const result = await api.setAllThresholds(conservative);
                            setThresholds(result.thresholds || []);
                          } catch (err) {
                            alert('Failed: ' + err.message);
                          }
                          setSaving(false);
                        }}
                        disabled={saving}
                      >
                        🐢 Conservative
                      </button>
                      <button 
                        className="btn btn-outline"
                        onClick={async () => {
                          // Linear: simple 1:1
                          const linear = [
                            { exposure_percent: 0, pullback_percent: 100 },
                            { exposure_percent: 25, pullback_percent: 75 },
                            { exposure_percent: 50, pullback_percent: 50 },
                            { exposure_percent: 75, pullback_percent: 25 },
                            { exposure_percent: 100, pullback_percent: 0 },
                          ];
                          if (!confirm('Apply linear preset? (1:1 pullback)')) return;
                          setSaving(true);
                          try {
                            const result = await api.setAllThresholds(linear);
                            setThresholds(result.thresholds || []);
                          } catch (err) {
                            alert('Failed: ' + err.message);
                          }
                          setSaving(false);
                        }}
                        disabled={saving}
                      >
                        📏 Linear
                      </button>
                    </div>
                  </div>

                  {/* EXPLANATION */}
                  <div className="pullback-explanation">
                    <h4>How It Works</h4>
                    <ul>
                      <li><strong>Exposure %</strong> = (Current NO shares value) / (Max Acceptable Loss)</li>
                      <li><strong>Pullback %</strong> = How much liquidity to offer at that exposure level</li>
                      <li>The bot uses the <em>highest matching</em> threshold (floor behavior)</li>
                      <li>Example: At 30% exposure with thresholds at 25%→75% and 50%→50%, you get 75% liquidity</li>
                    </ul>
                  </div>

                  <button 
                    className="btn btn-outline"
                    onClick={async () => {
                      setLoadingPullback(true);
                      try {
                        const [status, thresholdsData] = await Promise.all([
                          api.getPullbackStatus(),
                          api.getThresholds()
                        ]);
                        setPullbackStatus(status);
                        setThresholds(thresholdsData || []);
                      } catch (err) {
                        console.error('Failed to refresh:', err);
                      }
                      setLoadingPullback(false);
                    }}
                    style={{ marginTop: '1rem' }}
                  >
                    🔄 Refresh
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <button className="btn btn-outline modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
