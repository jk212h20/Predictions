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
  
  // Tier management state
  const [tiers, setTiers] = useState([]);
  const [loadingTiers, setLoadingTiers] = useState(false);
  const [expandedTier, setExpandedTier] = useState(null);
  const [tierMarkets, setTierMarkets] = useState({});
  
  // Track which tier is being dragged and its local value
  const [draggingTier, setDraggingTier] = useState(null);
  const [localTierValues, setLocalTierValues] = useState({});

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

  // Handle tier budget change
  const handleTierBudgetChange = async (tier, newBudget) => {
    setSaving(true);
    try {
      const result = await api.setTierBudget(tier, newBudget);
      setTiers(result.tiers || []);
    } catch (err) {
      alert('Failed to update tier budget: ' + err.message);
    }
    setSaving(false);
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
                  <strong>Shape your curve!</strong> Drag bars to adjust. Bars show <strong>percentages that total 100%</strong>.
                  Points at 0% stay at 0% when you adjust others. Add points at any price, delete points you don't need.
                </p>
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
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('exponential', { decay: 0.08 });
                      setCurvePoints(result.normalized_points.map(p => ({ price: p.price, weight: p.weight })));
                    } catch (err) { console.error(err); }
                  }}
                >
                  📉 Exponential
                </button>
                <button 
                  className="btn btn-small"
                  onClick={async () => {
                    try {
                      const result = await api.previewShape('parabolic', { maxPrice: 55 });
                      setCurvePoints(result.normalized_points.map(p => ({ price: p.price, weight: p.weight })));
                    } catch (err) { console.error(err); }
                  }}
                >
                  ⌒ Parabolic
                </button>
                
                {/* SAVED CUSTOM CURVES */}
                {savedCurves.length > 0 && (
                  <>
                    <span className="preset-divider">|</span>
                    <span className="preset-label">Saved:</span>
                    {savedCurves.map(curve => (
                      <button 
                        key={curve.id}
                        className="btn btn-small btn-custom"
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
                        title={`Load "${curve.name}"`}
                      >
                        ✏️ {curve.name}
                      </button>
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

              {/* DRAWABLE CURVE - Dynamic points */}
              <div className="curve-drawable">
                <div className="curve-y-axis">
                  <span>50%</span>
                  <span>25%</span>
                  <span>10%</span>
                  <span>0%</span>
                </div>
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
                          className="curve-bar-fill"
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
                  {/* SUMMARY */}
                  <div className="deploy-summary">
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
                        ⚠️ No markets with assigned weights. Click "Initialize Weights" in Configuration first.
                      </div>
                    )}
                  </div>
                  
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
                                  ? (localTierValues[tier.tier] ?? parseFloat(tier.budgetPercent) || 0)
                                  : (parseFloat(tier.budgetPercent) || 0)
                                }
                                onChange={e => {
                                  // Update local state only while dragging - don't call API
                                  const newValue = parseFloat(e.target.value);
                                  setDraggingTier(tier.tier);
                                  setLocalTierValues(prev => ({ ...prev, [tier.tier]: newValue }));
                                }}
                                onMouseUp={e => {
                                  // Call API only on release
                                  const newValue = localTierValues[tier.tier];
                                  if (newValue !== undefined) {
                                    handleTierBudgetChange(tier.tier, newValue);
                                  }
                                  setDraggingTier(null);
                                  setLocalTierValues({});
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
        </div>

        <button className="btn btn-outline modal-close" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
