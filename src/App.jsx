import React, { useState, useRef, useEffect } from 'react';
import { Send, ExternalLink, Database, Brain, Settings, BookOpen, Info } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { processMessage, getQAInfo, LLM_PROVIDERS, getCurrentProvider, setCurrentProvider, getQASettings, setQASettings, findBestMatch, listDatasets, selectDataset } from './services/openaiService.js';
import { processUserMessage } from './lib/chatUtils.js';
import { createChatSettings, createChatMessage } from './lib/types.js';
import WLOSidebar from './components/WLOSidebar.jsx';
import LearningAnalyticsSidebar from './components/LearningAnalyticsSidebar.jsx';
import ImpressumModal from './components/ImpressumModal.jsx';
import { learningAnalytics } from './lib/learningAnalytics.js';
import { BloomTaxonomyTracker } from './lib/bloomTaxonomy.js';

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [qaInfo, setQaInfo] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [currentProvider, setCurrentProviderState] = useState(null);
  const [qaSettings, setQASettingsState] = useState({ enabled: true, similarityThreshold: 0.5 });
  const [wloSettings, setWLOSettings] = useState({ enabled: true, debugMode: false, sourceFilter: '', environment: 'production', sidebarMode: 'used' });
  const [currentWLOSuggestions, setCurrentWLOSuggestions] = useState([]);
  const [usedWLOSuggestions, setUsedWLOSuggestions] = useState([]);
  const [promptWLOSuggestions, setPromptWLOSuggestions] = useState([]);
  const [learningProgress, setLearningProgress] = useState(learningAnalytics.getLearningProgress());
  const [showImpressum, setShowImpressum] = useState(false);
  const [bloomTracker] = useState(() => new BloomTaxonomyTracker());
  const [bloomGoalData, setBloomGoalData] = useState(null);
  const [datasets, setDatasets] = useState([]);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    // Load QA info on component mount
    loadQAInfo();
    
    // Load current provider - default to OpenAI if none set
    const provider = getCurrentProvider();
    setCurrentProviderState(provider);
    
    // Set default provider to OpenAI if none exists in localStorage
    if (!localStorage.getItem('llm_provider')) {
      setCurrentProvider('openai');
    }
    
    // Load QA settings
    const qaSettingsData = getQASettings();
    setQASettingsState(qaSettingsData);
    
    // Load API key from environment variable based on current provider
    const envApiKey = import.meta.env[provider.apiKeyEnv];
    if (envApiKey) {
      setApiKey(envApiKey);
    }
    
    // Load dataset list
    try {
      const ds = listDatasets();
      setDatasets(ds);
    } catch (e) {
      console.warn('Dataset list failed:', e);
    }

    // Add welcome message
    setMessages([{
      id: Date.now(),
      role: 'assistant',
      content: 'Hallo! Ich bin dein KI-Tutor. Ich kann dir bei verschiedenen Lernthemen helfen und passende Lernmaterialien von WirLernenOnline.de finden. Stelle mir gerne eine Frage!',
      isQABased: false,
      wloSuggestions: [],
      timestamp: new Date()
    }]);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const loadQAInfo = async () => {
    try {
      const info = await getQAInfo();
      setQaInfo(info);
    } catch (error) {
      console.error('Failed to load QA info:', error);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    // In Serverless-Proxy-Modus (baseUrl beginnt mit /api/) wird kein Client-API-Key benötigt.
    const needsClientKey = currentProvider?.baseUrl && !currentProvider.baseUrl.startsWith('/api/');
    if (needsClientKey && !apiKey) {
      setError(`${currentProvider?.name || 'LLM'} API Key nicht gefunden. Bitte Umgebungsvariablen prüfen oder Serverless-Proxy verwenden.`);
      return;
    }

    const userMessage = {
      id: Date.now(),
      role: 'user',
      content: inputValue.trim(),
      wloSuggestions: [],
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsLoading(true);
    setError(null);
    // Für 'Nur verwendete' Sidebar: vor neuer Antwort zurücksetzen
    if (wloSettings.sidebarMode === 'used') {
      setUsedWLOSuggestions([]);
    }
    // Prompt-verwendete Materialien immer vor neuem Turn zurücksetzen
    setPromptWLOSuggestions([]);

    try {
      const conversationHistory = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      // Kick off WLO in parallel (non-blocking). We'll only await it if kein QA-Match.
      let wloPromise = null;
      if (wloSettings.enabled) {
        wloPromise = (async () => {
          try {
            const chatSettings = createChatSettings(
              currentProvider?.id === 'gwdg',
              wloSettings.enabled,
              wloSettings.debugMode,
              wloSettings.sourceFilter,
              wloSettings.environment
            );
            const res = await processUserMessage(
              userMessage.content,
              messages,
              chatSettings
            );
            if (res && res.wloSuggestions) {
              setCurrentWLOSuggestions(res.wloSuggestions);
            }
            return res;
          } catch (wloError) {
            console.warn('WLO processing failed:', wloError);
            return null;
          }
        })();
      }

      // QA hat Priorität: ggf. Embedding-Match (API) oder String-Match
      const qaMatchPre = qaSettings?.enabled ? await findBestMatch(userMessage.content) : null;

      let response;
      let usedWLO = false;
      let wloForPrompt = [];
      if (qaMatchPre) {
        // QA-basierte Antwort erzeugen
        // Warte kurz auf WLO-Vorschläge dieser Anfrage (falls verfügbar), damit der Systemprompt sie immer erhält
        let wloForThisTurn = currentWLOSuggestions;
        try {
          if (wloPromise) {
            const wloRes = await wloPromise;
            if (wloRes && Array.isArray(wloRes.wloSuggestions)) {
              wloForThisTurn = wloRes.wloSuggestions;
            }
          }
        } catch {}
        wloForPrompt = Array.isArray(wloForThisTurn) ? wloForThisTurn : [];
        response = await processMessage(userMessage.content, conversationHistory, wloForThisTurn);
      } else {
        // Kein QA-Match: Wenn WLO aktiv, warte auf WLO-Antwort; sonst Standard-KI
        const wloResponseMain = wloPromise ? await wloPromise : null;
        if (wloResponseMain) {
          response = wloResponseMain;
          usedWLO = true;
          wloForPrompt = Array.isArray(wloResponseMain.wloSuggestions) ? wloResponseMain.wloSuggestions : [];
        } else {
          // Kein WLO-Ergebnis verfügbar -> normale KI-Antwort, aber mit bisherigen WLO-Vorschlägen
          wloForPrompt = Array.isArray(currentWLOSuggestions) ? currentWLOSuggestions : [];
          response = await processMessage(userMessage.content, conversationHistory, currentWLOSuggestions);
        }
      }

      const assistantMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: response.message,
        isQABased: usedWLO ? false : (response.isQABased || false),
        sourceUrl: usedWLO ? null : response.sourceUrl,
        provider: currentProvider?.name,
        model: currentProvider?.model,
        qaMatch: usedWLO ? null : response.qaMatch,
        wloSuggestions: usedWLO ? (response.wloSuggestions || []) : [],
        timestamp: new Date()
      };

      setMessages(prev => [...prev, assistantMessage]);

      // Merke die Materialien, die im PROMPT verwendet wurden (je Turn)
      setPromptWLOSuggestions(wloForPrompt);

      // Aktualisiere Liste der im Chat tatsächlich verwendeten WLO-Materialien
      try {
        const env = wloSettings.environment;
        const baseUrl = env === 'staging' 
          ? 'https://repository.staging.openeduhub.net/edu-sharing' 
          : 'https://redaktion.openeduhub.net/edu-sharing';
        const resolveUrl = (s) => {
          const direct = s?.wwwUrl || s?.url;
          if (direct) return direct;
          return s?.refId ? `${baseUrl}/components/render/${s.refId}` : '';
        };
        // Für die Erkennung der im Chat VERWENDETEN Materialien prüfen wir immer nur gegen
        // die tatsächlich im Prompt übergebenen Materialien dieses Turns (wloForPrompt),
        // oder – falls die Antwort direkt aus WLO kommt – gegen die gelieferten Vorschläge
        // der Antwort (response.wloSuggestions).
        const candidateSuggestions = usedWLO ? (response.wloSuggestions || []) : wloForPrompt;
        const referenced = [];
        for (const s of candidateSuggestions) {
          const url = resolveUrl(s);
          const refId = s?.refId || '';
          const stripProtocol = (u) => u.replace(/^https?:\/\//, '');
          const trimSlash = (u) => u.endsWith('/') ? u.slice(0, -1) : u;
          const content = assistantMessage.content || '';
          let matched = false;
          if (url) {
            const urlNoProto = stripProtocol(url);
            const urlNoSlash = trimSlash(url);
            const urlNoProtoNoSlash = trimSlash(urlNoProto);
            if (
              content.includes(url) ||
              content.includes(urlNoProto) ||
              content.includes(urlNoSlash) ||
              content.includes(urlNoProtoNoSlash)
            ) {
              matched = true;
            }
          }
          if (!matched && refId) {
            if (content.includes(refId)) matched = true;
          }
          if (matched) referenced.push({ ...s, url });
        }
        // Zeige in der rechten Leiste (Modus 'used') nur die im AKTUELLEN Assistant-Turn referenzierten Materialien
        setUsedWLOSuggestions(referenced);
      } catch (e2) {
        console.warn('Used WLO extraction failed:', e2);
      }

      // Start Learning Analytics after response - with detailed error tracking
      setTimeout(async () => {
        console.log('🔄 Starting tracking functions...');
        try {
          console.log('📊 Checking learning analytics availability...');
          if (learningAnalytics && typeof learningAnalytics.analyzeConversation === 'function') {
            console.log('📊 Starting learning analytics...');
            const updatedProgress = await learningAnalytics.analyzeConversation(
              [...messages, userMessage],
              userMessage.content,
              response.message
            );
            console.log('📊 Learning analytics result:', updatedProgress);
            
            if (updatedProgress) {
              console.log('📊 Updating learning progress state...');
              const freshProgress = learningAnalytics.getLearningProgress();
              setLearningProgress(freshProgress);
              console.log('📊 Learning progress updated successfully');
            }

            // Update Bloom taxonomy tracker
            console.log('🌸 Checking Bloom tracker availability...');
            if (bloomTracker && typeof bloomTracker.updateAfterTurn === 'function') {
              try {
                console.log('🌸 Starting Bloom tracker...');
                const bloomGoalData = await bloomTracker.updateAfterTurn(
                  userMessage.content,
                  assistantMessage,
                  [...messages, userMessage, assistantMessage],
                  learningAnalytics.getLearningProgress()
                );
                console.log('🌸 Bloom tracker result:', bloomGoalData);
                
                if (bloomGoalData) {
                  console.log('🌸 Updating Bloom goal data state...');
                  setBloomGoalData(bloomGoalData);
                  console.log('🌸 Bloom goal data updated successfully');
                }
              } catch (bloomError) {
                console.error('🌸 Bloom tracker failed:', bloomError);
                console.error('🌸 Bloom error stack:', bloomError.stack);
              }
            } else {
              console.warn('🌸 Bloom tracker not available');
            }
          } else {
            console.warn('📊 Learning analytics not available');
          }
          console.log('✅ All tracking functions completed');
        } catch (analyticsError) {
          console.error('📊 Learning analytics failed:', analyticsError);
          console.error('📊 Analytics error stack:', analyticsError.stack);
        }
      }, 500); // Increased delay
    } catch (error) {
      console.error('Chat error:', error);
      setError(`Fehler: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
  };

  const handleProviderChange = (providerId) => {
    const provider = Object.values(LLM_PROVIDERS).find(p => p.id === providerId);
    if (!provider) return;
    
    setCurrentProvider(providerId);
    setCurrentProviderState(provider);
    
    // Update API key based on new provider
    const envApiKey = import.meta.env[provider.apiKeyEnv];
    if (envApiKey) {
      setApiKey(envApiKey);
    } else {
      setApiKey('');
    }
    
    setShowSettings(false);
  };

  const handleQASettingsChange = (newSettings) => {
    setQASettings(newSettings);
    setQASettingsState(newSettings);
  };


  const handleTopicSelect = (topicId) => {
    // Update current topic in learning analytics
    learningAnalytics.learningProgress.currentTopic = topicId;
    setLearningProgress(learningAnalytics.getLearningProgress());
  };

  // Hilfsfunktion: Teilt Assistant-Content nach QA/AI-Abschnitten anhand der Pflicht-Labels
  // Gibt Array aus Abschnitten mit type: 'qa' | 'ai' | 'unknown' und text (Markdown) zurück
  const splitAssistantContent = (md = '') => {
    // Unterstütze mehrere Varianten der Labels (mit/ohne **, mit/ohne [ ])
    const core = 'GEPRÜFTE ANTWORT AUF QA-BASIS|UNSICHERE ANTWORT AUF KI-BASIS|UNSICHERE ERGÄNZUNG AUF KI-BASIS';
    // 1) Prüfen, ob überhaupt Labels vorhanden sind
    const detectRe = new RegExp(`(?:\\*\\*)?\\[?(?:${core})\\]?\\*\\*?`, 'i');
    if (!detectRe.test(md)) return [];
    // 2) Teile den Text an Labels (ohne Capturing-Groups, damit keine Labels in parts injiziert werden)
    const splitRe = new RegExp(`(?:\\*\\*)?\\[?(?:${core})\\]?\\*\\*?`, 'g');
    const parts = md.split(splitRe); // [pre, body1, body2, ...]
    // 3) Extrahiere die reinen Label-Texte separat
    const labelRe = new RegExp(`(?:\\*\\*)?\\[?(${core})\\]?\\*\\*?`, 'g');
    const labelMatches = [...md.matchAll(labelRe)].map(m => m[1]);

    const sections = [];
    const pre = (parts[0] || '').trim();
    if (pre) sections.push({ type: 'unknown', text: pre });
    for (let i = 0; i < labelMatches.length; i++) {
      const rawLabel = labelMatches[i] || '';
      const body = (parts[i + 1] || '').trim(); // korrekt gepaart mit i-ter Marke
      const isQA = rawLabel.toUpperCase().includes('GEPRÜFTE');
      const type = isQA ? 'qa' : 'ai';
      const text = `**[${rawLabel}]**\n\n${body}`.trim();
      sections.push({ type, text });
    }
    return sections;
  };

  return (
    <div className="app-layout">
      {/* Learning Analytics Sidebar */}
      <LearningAnalyticsSidebar 
        learningProgress={learningProgress}
        onTopicSelect={handleTopicSelect}
        bloomGoalData={bloomGoalData}
      />
      
      <div className="chat-container">
      <div className="status-bar">
        <div className="status-indicator">
          <div className="status-dot"></div>
          <span>{currentProvider?.name || 'Client-Only'} ({currentProvider?.model || 'Unbekannt'})</span>
          {qaInfo && qaSettings.enabled && (
            <span className="qa-info">• {qaInfo.count} QA Paare aktiv</span>
          )}
          {wloSettings.enabled && (
            <span className="wlo-info">
              • WLO Integration aktiv ({wloSettings.environment === 'staging' ? 'Staging' : 'Produktiv'}{wloSettings.sourceFilter ? `, ${wloSettings.sourceFilter}` : ''})
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button 
            className="settings-button"
            onClick={() => setShowImpressum(!showImpressum)}
            title="Impressum"
            style={{
              background: 'none',
              border: 'none',
              color: '#6b7280',
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.8rem'
            }}
          >
            Impressum
          </button>
          <button 
            className="settings-button"
            onClick={() => setShowSettings(!showSettings)}
            title="Einstellungen"
          >
            <Settings size={16} />
          </button>
        </div>
      </div>
      <div className="chat-header">
        <h1>🎓 Tutor Chatbot</h1>
        <p>Ihr intelligenter Lernbegleiter mit Faktenwissen</p>
      </div>

      {showSettings && (
        <div style={{
          background: '#f8fafc',
          border: '1px solid #e2e8f0',
          padding: '20px',
          margin: '0 20px',
          borderRadius: '12px',
          boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
        }}>
          <h3 style={{ margin: '0 0 16px 0', color: '#1f2937', fontSize: '1.1rem' }}>
            <Settings size={16} style={{ display: 'inline', marginRight: '8px' }} />
            LLM Provider Einstellungen
          </h3>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {Object.values(LLM_PROVIDERS).map(provider => (
              <label 
                key={provider.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px',
                  border: currentProvider?.id === provider.id ? '2px solid #667eea' : '1px solid #e2e8f0',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  background: currentProvider?.id === provider.id ? '#f0f9ff' : 'white',
                  minWidth: 0
                }}
              >
                <input
                  type="radio"
                  name="llmProvider"
                  value={provider.id}
                  checked={currentProvider?.id === provider.id}
                  onChange={() => handleProviderChange(provider.id)}
                  style={{ margin: 0 }}
                />
                <div>
                  <div style={{ fontWeight: '600', color: '#1f2937', fontSize: '0.95rem' }}>{provider.name}</div>
                  <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>Modell: {provider.model}</div>
                  <div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>{provider.baseUrl}</div>
                </div>
              </label>
            ))}
          </div>
          
          
          <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e2e8f0' }}>
            <h4 style={{ margin: '0 0 12px 0', color: '#1f2937', fontSize: '1rem' }}>WLO Integration Einstellungen</h4>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: '12px', marginBottom: '16px', alignItems: 'start' }}>
              <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={wloSettings.enabled}
                  onChange={(e) => setWLOSettings({ ...wloSettings, enabled: e.target.checked })}
                  style={{ margin: 0 }}
                />
                <span style={{ fontWeight: '500', color: '#374151' }}>WLO Lernmaterialien verwenden</span>
              </label>

              {/* Links: Quelle + Debug in einer Zeile */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', opacity: wloSettings.enabled ? 1 : 0.5 }}>
                <input
                  type="text"
                  placeholder="Quelle einschränken (optional)"
                  value={wloSettings.sourceFilter || ''}
                  onChange={(e) => setWLOSettings({ ...wloSettings, sourceFilter: e.target.value })}
                  disabled={!wloSettings.enabled}
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    background: wloSettings.enabled ? 'white' : '#f9fafb',
                    cursor: wloSettings.enabled ? 'text' : 'not-allowed'
                  }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: wloSettings.enabled ? 'pointer' : 'not-allowed', opacity: wloSettings.enabled ? 1 : 0.5 }}>
                  <input
                    type="checkbox"
                    checked={wloSettings.debugMode}
                    onChange={(e) => setWLOSettings({ ...wloSettings, debugMode: e.target.checked })}
                    disabled={!wloSettings.enabled}
                    style={{ margin: 0 }}
                  />
                  <span style={{ fontWeight: '500', color: '#374151', fontSize: '0.85rem' }}>Debug</span>
                </label>
              </div>

              {/* Rechts: Repository/Umgebung Dropdown (ohne Überschrift) */}
              <div style={{ opacity: wloSettings.enabled ? 1 : 0.5 }}>
                <select
                  value={wloSettings.environment}
                  onChange={(e) => setWLOSettings({ ...wloSettings, environment: e.target.value })}
                  disabled={!wloSettings.enabled}
                  title="WLO Repository"
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    background: wloSettings.enabled ? 'white' : '#f9fafb',
                    cursor: wloSettings.enabled ? 'pointer' : 'not-allowed'
                  }}
                >
                  <option value="production">Produktiv</option>
                  <option value="staging">Staging</option>
                </select>
              </div>

              {/* Anzeige-Modus: Alle vs. im Chat verwendete */}
              <div style={{ opacity: wloSettings.enabled ? 1 : 0.5 }}>
                <select
                  value={wloSettings.sidebarMode}
                  onChange={(e) => setWLOSettings({ ...wloSettings, sidebarMode: e.target.value })}
                  disabled={!wloSettings.enabled}
                  title="Anzeige der WLO-Seitenleiste"
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    background: wloSettings.enabled ? 'white' : '#f9fafb',
                    cursor: wloSettings.enabled ? 'pointer' : 'not-allowed'
                  }}
                >
                  <option value="all">Alle Materialien anzeigen</option>
                  <option value="used">Nur im Chat verwendete anzeigen</option>
                </select>
              </div>

              {/* Hinweis unter der linken Spalte */}
              <div style={{ gridColumn: '1 / 2', fontSize: '0.72rem', color: '#9ca3af' }}>
                Leer lassen für alle Quellen
              </div>
            </div>
            
            <h4 style={{ margin: '0 0 12px 0', color: '#1f2937', fontSize: '1rem' }}>QA-Dataset Einstellungen</h4>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={qaSettings.enabled}
                  onChange={(e) => handleQASettingsChange({ ...qaSettings, enabled: e.target.checked })}
                  style={{ margin: 0 }}
                />
                <span style={{ fontWeight: '500', color: '#374151' }}>QA-Paare verwenden</span>
              </label>
              
              {/* Dataset selector */}
              <div>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>
                  Aktives Dataset:
                </label>
                <select
                  value={qaSettings.datasetId || ''}
                  onChange={(e) => {
                    const id = e.target.value;
                    selectDataset(id);
                    const next = { ...qaSettings, datasetId: id };
                    handleQASettingsChange(next);
                    loadQAInfo();
                  }}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    fontSize: '0.9rem',
                    background: 'white',
                    cursor: 'pointer',
                    marginBottom: '12px'
                  }}
                >
                  {datasets.map(ds => (
                    <option key={ds.id} value={ds.id}>{ds.name}</option>
                  ))}
                </select>
                {qaInfo && (
                  <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>
                    {qaInfo.count} Einträge • Kategorien: {qaInfo.categories?.length || 0}
                  </div>
                )}
              </div>

              {/* Matching-Methode entfernt: nur Embedding-basiertes Matching */}

              <div style={{ gridColumn: '1 / -1', opacity: qaSettings.enabled ? 1 : 0.5 }}>
                <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500', color: '#374151' }}>
                  Ähnlichkeitsschwelle: {(qaSettings.similarityThreshold * 100).toFixed(0)}%
                </label>
                <input
                  type="range"
                  min="0.1"
                  max="0.9"
                  step="0.05"
                  value={qaSettings.similarityThreshold}
                  onChange={(e) => handleQASettingsChange({ ...qaSettings, similarityThreshold: parseFloat(e.target.value) })}
                  disabled={!qaSettings.enabled}
                  style={{
                    width: '100%',
                    height: '6px',
                    borderRadius: '3px',
                    background: '#e2e8f0',
                    outline: 'none',
                    cursor: qaSettings.enabled ? 'pointer' : 'not-allowed'
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#9ca3af', marginTop: '4px' }}>
                  <span>10% (sehr streng)</span>
                  <span>90% (sehr locker)</span>
                </div>
              </div>

              {/* Live Embedding-Precompute entfernt: Assets kommen aus public/quant */}
            </div>
          </div>
          
          <div style={{ 
            marginTop: '16px', 
            padding: '12px', 
            background: '#fef3c7', 
            border: '1px solid #f59e0b', 
            borderRadius: '6px',
            fontSize: '0.85rem',
            color: '#92400e'
          }}>
            <strong>Aktueller Provider:</strong> {currentProvider?.name} ({currentProvider?.model})<br/>
            <strong>API Key Status:</strong> {apiKey ? '✅ Geladen' : '❌ Nicht gefunden'}<br/>
            <strong>WLO Integration:</strong> {wloSettings.enabled ? '✅ Aktiv' : '❌ Deaktiviert'}<br/>
            <strong>QA-Paare:</strong> {qaSettings.enabled ? `✅ Aktiv (${(qaSettings.similarityThreshold * 100).toFixed(0)}% Schwelle)` : '❌ Deaktiviert'}
          </div>
        </div>
      )}

      <div className="chat-messages">
        {messages.map((message) => (
          <div key={message.id} className={`message ${message.role}`}>
            <div className="message-avatar">
              {message.role === 'user' ? 'Du' : '🤖'}
            </div>
            <div className="message-content">
              {message.role === 'assistant' && (
                <div className="message-badge">
                  {message.isQABased ? (
                    <span className="qa-badge" style={{ fontWeight: 600 }}>
                      <Database size={12} style={{ display: 'inline', marginRight: '4px' }} />
                      GEPRÜFTE ANTWORT AUF QA-BASIS
                    </span>
                  ) : (
                    <span className="ai-badge" style={{ fontWeight: 600 }}>
                      <Brain size={12} style={{ display: 'inline', marginRight: '4px' }} />
                      UNSICHERE ANTWORT AUF KI-BASIS
                    </span>
                  )}
                </div>
              )}
              
              <div className="message-content">
                {message.role === 'assistant' ? (() => {
                  const sections = splitAssistantContent(message.content);
                  if (sections.length === 0) {
                    return (
                      <ReactMarkdown
                        components={{
                          a: ({ href, children, ...props }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                              {children}
                            </a>
                          )
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    );
                  }
                  return (
                    <div>
                      {sections.map((sec, idx) => (
                        <div key={idx} style={{
                          background: sec.type === 'qa' ? '#f0fdf4' : 'transparent',
                          border: sec.type === 'qa' ? '1px solid #bbf7d0' : 'none',
                          borderRadius: 10,
                          padding: sec.type === 'qa' ? '12px' : 0,
                          marginBottom: idx < sections.length - 1 ? 10 : 0
                        }}>
                          <ReactMarkdown
                            components={{
                              a: ({ href, children, ...props }) => (
                                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                                  {children}
                                </a>
                              )
                            }}
                          >
                            {sec.text}
                          </ReactMarkdown>
                          {sec.type === 'qa' && message.sourceUrl && (
                            <div style={{ marginTop: '8px' }}>
                              <a
                                href={message.sourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#166534', fontWeight: 600 }}
                              >
                                <ExternalLink size={14} />
                                Zur Lernressource
                              </a>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })() : (
                  <ReactMarkdown
                    components={{
                      a: ({ href, children, ...props }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                          {children}
                        </a>
                      )
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                )}
              </div>

            </div>
          </div>
        ))}
        
        {isLoading && (
          <div className="message assistant">
            <div className="message-avatar">🤖</div>
            <div className="typing-indicator">
              <span>Denkt nach</span>
              <div className="typing-dots">
                <div className="typing-dot"></div>
                <div className="typing-dot"></div>
                <div className="typing-dot"></div>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div className="error-message">
          {error}
        </div>
      )}

      <div className="chat-input-container">
        <form onSubmit={handleSubmit} className="chat-input-form">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              adjustTextareaHeight();
            }}
            onKeyPress={handleKeyPress}
            placeholder="Stelle deine Frage..."
            className="chat-input"
            disabled={isLoading}
            rows={1}
          />
          <button
            type="submit"
            disabled={!inputValue.trim() || isLoading}
            className="send-button"
          >
            <Send size={20} />
          </button>
        </form>
      </div>
      </div>
      
      {/* Impressum Modal */}
      <ImpressumModal 
        isOpen={showImpressum}
        onClose={() => setShowImpressum(false)}
      />
      
      <WLOSidebar 
        suggestions={
          wloSettings.sidebarMode === 'used'
            ? usedWLOSuggestions
            : currentWLOSuggestions
        }
        isLoading={isLoading && wloSettings.enabled}
        className="wlo-sidebar-container"
      />
    </div>
  );
}

export default App;
