import {
  Box,
  Paper,
  Typography,
  TextField,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  Stack,
  Chip,
  CircularProgress,
  Avatar,
  IconButton,
  Badge,
  LinearProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  Switch,
  Menu,
  Tooltip
} from '@mui/material';
import { Search as SearchIcon, Send as SendIcon, Refresh as RefreshIcon, TextSnippet as TemplateIcon } from '@mui/icons-material';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { toast } from 'react-toastify';
import api from '../../services/api';
import { socketConnection } from '../../services/socket';
import { useSavedReplies, useTemplates } from '../../hooks/useApi';

type TemplateItem = {
  id: number;
  name: string;
};

type ConversationItem = {
  contactId: number;
  name: string;
  number: string;
  lastMessage?: string;
  updatedAt?: string;
  ticketCount: number;
  statuses: string[];
};

const stageFromScore = (score: number) => {
  if (score >= 75) return 'interesado';
  if (score >= 50) return 'calificado';
  if (score >= 25) return 'contactado';
  return 'nuevo';
};

const scoreFromStage = (stage: string) => {
  switch (stage) {
    case 'interesado':
      return 85;
    case 'calificado':
      return 60;
    case 'contactado':
      return 35;
    default:
      return 10;
  }
};

const isHttpUrl = (value?: string) => /^https?:\/\//i.test(String(value || '').trim());
const sanitizeUrl = (url?: string) => String(url || '').trim().replace(/[),.;]+$/,'');
const extractFirstUrl = (value?: string) => {
  const m = String(value || '').match(/https?:\/\/[^\s]+/i);
  return sanitizeUrl(m?.[0] || '');
};

const normalizePreviewImageUrl = (image?: string, baseUrl?: string) => {
  const raw = String(image || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (baseUrl && /^https?:\/\//i.test(baseUrl)) {
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return '';
    }
  }
  return '';
};

const fallbackPreviewImageUrl = (url?: string) => {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return '';
  return `https://image.thum.io/get/width/1200/noanimate/${encodeURIComponent(clean)}`;
};

const buildSummary = (msgs: any[]) => {
  const inbound = (msgs || []).filter((m) => !m.fromMe && String(m.body || '').trim());
  if (inbound.length === 0) return 'Sin contexto todavía. Esperando más mensajes del cliente.';

  const latest = inbound.slice(-6).map((m) => String(m.body || '').trim()).filter(Boolean);
  const full = latest.join(' ').toLowerCase();

  let intent = 'consulta general';
  if (/precio|plan|costo|cu[aá]nto/i.test(full)) intent = 'consulta de precios';
  else if (/turno|agenda|cita|horario/i.test(full)) intent = 'coordinar cita';
  else if (/problema|error|no funciona|ayuda/i.test(full)) intent = 'soporte/incidencia';
  else if (/comprar|contratar|quiero/i.test(full)) intent = 'intención de compra';

  return `El cliente está en ${intent}. ltimos puntos: ${latest.slice(-2).join(' | ')}`;
};

const Conversations = () => {
  const [tickets, setTickets] = useState<any[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [selectedConv, setSelectedConv] = useState<ConversationItem | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const { data: savedReplies = [] } = useSavedReplies();
  const { data: templates = [] } = useTemplates();
  const [templateLanguage] = useState('es_AR');
  const [templateMenuAnchor, setTemplateMenuAnchor] = useState<null | HTMLElement>(null);
  const [linkPreviews, setLinkPreviews] = useState<Record<string, { title?: string; description?: string; image?: string; host?: string }>>({});

  const [contactData, setContactData] = useState<any>(null);
  const [savingLeadStage, setSavingLeadStage] = useState(false);
  const [savingProgress, setSavingProgress] = useState(false);
  const [savingHandoff, setSavingHandoff] = useState(false);
  const [decisionLogs, setDecisionLogs] = useState<any[]>([]);
  const messagesFetchSeq = useRef(0);
  const contactFetchSeq = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const selectedConvRef = useRef<ConversationItem | null>(null);

  // Keep ref in sync so socket callbacks always see current selection
  useEffect(() => { selectedConvRef.current = selectedConv; }, [selectedConv]);

  const toTs = (value?: string | number) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const t = new Date(String(value)).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  const fmtTime = (date?: string) => {
    const t = toTs(date);
    if (!t) return '';
    return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const fetchTickets = async () => {
    setLoadingTickets(true);
    try {
      const { data } = await api.get('/conversations');
      const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      setTickets(arr);
    } catch (e) {
      console.error(e);
      toast.error('Error al cargar conversaciones');
      setTickets([]);
    } finally {
      setLoadingTickets(false);
    }
  };

  const fetchContactData = async (contactId: number) => {
    const seq = ++contactFetchSeq.current;
    try {
      const { data } = await api.get('/contacts');
      if (seq !== contactFetchSeq.current) return;
      const raw = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      const arr = raw;
      const found = arr.find((c: any) => Number(c.id) === Number(contactId));
      setContactData(found || null);
    } catch {
      if (seq !== contactFetchSeq.current) return;
      setContactData(null);
    }
  };

  const fetchConversationMessages = async (contactId: number) => {
    const seq = ++messagesFetchSeq.current;
    setLoadingMessages(true);
    try {
      // Backend /messages/:conversationId expects contactId (not ticketId).
      // Add cache-buster to avoid stale 304 browser cache responses on chat history.
      const { data: msgs } = await api.get(`/messages/${contactId}`, {
        params: { _t: Date.now() }
      });
      const arr = Array.isArray(msgs) ? msgs : Array.isArray(msgs?.data) ? msgs.data : [];

      arr.sort((a: any, b: any) => {
        const da = toTs(a?.createdAt) || toTs(a?.updatedAt) || toTs(a?.timestamp);
        const db = toTs(b?.createdAt) || toTs(b?.updatedAt) || toTs(b?.timestamp);
        if (da !== db) return da - db;
        return Number(a?.id || 0) - Number(b?.id || 0);
      });

      if (seq !== messagesFetchSeq.current) return;

      // Fallback UX: if there are no persisted message rows yet,
      // show at least the latest ticket preview (e.g. "Template ... enviado")
      // so the chat pane is not empty.
      if (arr.length === 0) {
        const latestTicket = tickets
          .filter((t: any) => Number(t.contactId || t.contact?.id) === Number(contactId))
          .sort((a: any, b: any) => toTs(b?.updatedAt || b?.createdAt) - toTs(a?.updatedAt || a?.createdAt))[0];

        const fallbackBody = String(latestTicket?.lastMessage || '').trim();
        if (fallbackBody) {
          setMessages([
            {
              id: `fallback-${contactId}`,
              body: fallbackBody,
              fromMe: true,
              mediaType: 'chat',
              createdAt: latestTicket?.updatedAt || latestTicket?.createdAt || new Date().toISOString()
            }
          ] as any);
          return;
        }
      }

      setMessages(arr);
    } catch (e) {
      if (seq !== messagesFetchSeq.current) return;
      console.error(e);
      toast.error('Error al cargar mensajes');
      setMessages([]);
    } finally {
      if (seq !== messagesFetchSeq.current) return;
      setLoadingMessages(false);
    }
  };

  useEffect(() => {
    fetchTickets();
  }, []);

  useEffect(() => {
    const socket = socketConnection.connect();
    if (!socket) return;

    const handleNewMessage = (data: any) => {
      // Always refresh conversation list to update last message / ordering
      fetchTickets();
      // If viewing the same contact, append the message directly for instant UI
      const current = selectedConvRef.current;
      const incomingContactId = Number(
        data?.contactId || data?.message?.contactId || data?.contact?.id || 0
      );
      if (current && incomingContactId === current.contactId) {
        const msg = data?.message;
        if (msg?.id) {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m: any) => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        } else {
          // Fallback: re-fetch if message payload is incomplete
          fetchConversationMessages(current.contactId);
        }
      }
    };

    const handleTicketUpdate = () => {
      fetchTickets();
    };

    const handleReconnect = () => {
      // After reconnection, refresh everything to ensure UI is up-to-date
      fetchTickets();
      const current = selectedConvRef.current;
      if (current) fetchConversationMessages(current.contactId);
    };

    socket.on('newMessage', handleNewMessage);
    socket.on('ticketUpdate', handleTicketUpdate);
    socket.on('contactUpdate', handleTicketUpdate);
    socket.on('connect', handleReconnect);

    return () => {
      socket.off('newMessage', handleNewMessage);
      socket.off('ticketUpdate', handleTicketUpdate);
      socket.off('contactUpdate', handleTicketUpdate);
      socket.off('connect', handleReconnect);
    };
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const id = setInterval(() => { fetchTickets(); }, 30000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const urls = Array.from(new Set(messages
      .map((m: any) => sanitizeUrl(String(m.mediaUrl || extractFirstUrl(m.body) || '')))
      .filter((u: string) => isHttpUrl(u))));

    const toFetch = urls.filter((u) => !linkPreviews[u]);
    if (!toFetch.length) return;

    (async () => {
      const next: Record<string, any> = {};
      for (const url of toFetch.slice(0, 20)) {
        try {
          const { data } = await api.get('/ai/link-preview', { params: { url } });
          next[url] = data || {};
        } catch {
          next[url] = {};
        }
      }
      setLinkPreviews((prev) => ({ ...prev, ...next }));
    })();
  }, [messages]);

  const conversations: ConversationItem[] = useMemo(() => {
    const byContact = new Map<number, ConversationItem>();

    for (const t of tickets) {
      const contactId = t.contactId || t.contact?.id;
      if (!contactId) continue;

      const name = t.contact?.name || 'Sin nombre';
      const number = t.contact?.number || '';
      const updatedAt = t.updatedAt || t.createdAt;
      const current = byContact.get(contactId);
      const lastMessage = t.lastMessage || current?.lastMessage || '';

      if (!current) {
        byContact.set(contactId, {
          contactId,
          name,
          number,
          lastMessage,
          updatedAt,
          ticketCount: 1,
          statuses: [t.status].filter(Boolean)
        });
      } else {
        const curTs = current.updatedAt ? new Date(current.updatedAt).getTime() : 0;
        const nextTs = updatedAt ? new Date(updatedAt).getTime() : 0;
        const next: ConversationItem = {
          ...current,
          ticketCount: current.ticketCount + 1,
          statuses: Array.from(new Set([...(current.statuses || []), t.status].filter(Boolean)))
        };
        if (nextTs >= curTs) {
          next.updatedAt = updatedAt;
          if (t.lastMessage) next.lastMessage = t.lastMessage;
          next.name = name || next.name;
          next.number = number || next.number;
        }
        byContact.set(contactId, next);
      }
    }

    return Array.from(byContact.values()).sort((a, b) => {
      const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return db - da;
    });
  }, [tickets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) =>
      [c.name || '', c.number || '', c.lastMessage || ''].some((x) => x.toLowerCase().includes(q))
    );
  }, [conversations, search]);

  const fetchDecisionLogs = async (ticketId: number) => {
    if (!ticketId) {
      setDecisionLogs([]);
      return;
    }
    try {
      const { data } = await api.get(`/ai/tickets/${ticketId}/decisions`, { params: { limit: 30 } });
      setDecisionLogs(Array.isArray(data) ? data : []);
    } catch {
      setDecisionLogs([]);
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'open':
        return 'success';
      case 'pending':
        return 'warning';
      case 'closed':
        return 'default';
      default:
        return 'default';
    }
  };

  const handleSelect = async (c: ConversationItem) => {
    setSelectedConv(c);
    await Promise.all([fetchConversationMessages(c.contactId), fetchContactData(c.contactId)]);
    const latest = tickets.filter((t: any) => Number(t.contactId || t.contact?.id) === Number(c.contactId)).sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())[0];
    await fetchDecisionLogs(Number(latest?.id || 0));
  };

  const handleSend = async () => {
    if (!selectedConv?.contactId || !text.trim()) return;
    setSending(true);
    try {
      await api.post(`/contacts/${selectedConv.contactId}/message`, { body: text.trim() });
      setText('');
      await fetchTickets();
      await fetchConversationMessages(selectedConv.contactId);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.response?.data?.error || 'Error al enviar mensaje');
    } finally {
      setSending(false);
    }
  };

  const openTemplateMenu = (event: MouseEvent<HTMLElement>) => setTemplateMenuAnchor(event.currentTarget);
  const closeTemplateMenu = () => setTemplateMenuAnchor(null);

  const sendTemplateQuick = async (tpl: TemplateItem) => {
    if (!selectedConv?.contactId) return;
    setSending(true);
    try {
      await api.post(`/contacts/${selectedConv.contactId}/message`, {
        templateName: tpl.name,
        languageCode: templateLanguage
      });
      closeTemplateMenu();
      await fetchTickets();
      await fetchConversationMessages(selectedConv.contactId);
      toast.success(`Template enviado: ${tpl.name}`);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.response?.data?.error || 'No se pudo enviar template');
    } finally {
      setSending(false);
    }
  };

  const leadScore = Number(contactData?.lead_score || 0);
  const leadStage = stageFromScore(leadScore);
  const summary = useMemo(() => buildSummary(messages), [messages]);
  const latestTicketId = useMemo(() => {
    const m = [...messages].reverse().find((x: any) => Number(x.ticketId || 0) > 0);
    return Number(m?.ticketId || 0) || 0;
  }, [messages]);

  const latestTicket = useMemo(() => tickets.find((t: any) => Number(t.id) === Number(latestTicketId)) || null, [tickets, latestTicketId]);
  const botEnabledRaw = latestTicket?.bot_enabled;
  const humanOverrideRaw = latestTicket?.human_override;
  const isBotEnabled = (botEnabledRaw === undefined || botEnabledRaw === null ? true : Boolean(botEnabledRaw)) && !Boolean(humanOverrideRaw);

  const updateLeadStage = async (nextStage: string) => {
    if (!selectedConv?.contactId) return;
    const nextScore = scoreFromStage(nextStage);
    setSavingLeadStage(true);
    try {
      await api.post('/ai/tools/execute', {
        tool: 'actualizar_lead_score',
        args: { contactId: selectedConv.contactId, leadScore: nextScore }
      });
      await fetchContactData(selectedConv.contactId);
      toast.success('Estado del lead actualizado');
    } catch {
      toast.error('No se pudo actualizar el estado del lead');
    } finally {
      setSavingLeadStage(false);
    }
  };

  const progressTags = (contactData?.tags || []).map((t: any) => String(t.name || '').toLowerCase());
  const hasOpciones = progressTags.includes('opciones_presentadas');
  const hasInteres = progressTags.includes('interes_detectado');

  const toggleProgressTag = async (tag: string) => {
    if (!selectedConv?.contactId) return;
    setSavingProgress(true);
    try {
      const currentTags = (contactData?.tags || []).map((t: any) => String(t.name || '')).filter(Boolean);
      const lower = currentTags.map((x: string) => x.toLowerCase());
      const exists = lower.includes(tag.toLowerCase());
      const next = exists
        ? currentTags.filter((x: string) => x.toLowerCase() !== tag.toLowerCase())
        : [...currentTags, tag];

      await api.put(`/contacts/${selectedConv.contactId}`, {
        name: contactData?.name || selectedConv.name,
        number: contactData?.number || selectedConv.number,
        email: contactData?.email || '',
        source: contactData?.source || null,
        leadStatus: contactData?.leadStatus || 'read',
        assignedUserId: contactData?.assignedUserId || null,
        inactivityMinutes: contactData?.inactivityMinutes || 30,
        inactivityWebhookId: contactData?.inactivityWebhookId || null,
        tags: next
      });

      await fetchContactData(selectedConv.contactId);
    } catch {
      toast.error('No se pudo actualizar progreso del lead');
    } finally {
      setSavingProgress(false);
    }
  };

  const toggleHandoff = async (enableHuman: boolean) => {
    if (!latestTicketId) return;
    setSavingHandoff(true);
    try {
      await api.post(`/ai/tickets/${latestTicketId}/toggle-bot`, {
        botEnabled: !enableHuman,
        humanOverride: enableHuman
      });
      toast.success(enableHuman ? 'Intervención humana activada' : 'Bot IA reactivado');
      if (selectedConv?.contactId) await fetchConversationMessages(selectedConv.contactId);
      await fetchDecisionLogs(latestTicketId);
    } catch {
      toast.error('No se pudo actualizar handoff');
    } finally {
      setSavingHandoff(false);
    }
  };

  return (
    <Box sx={{ height: 'calc(100vh - 140px)' }}>
      <Paper
        sx={{
          height: '100%',
          display: 'flex',
          overflow: 'hidden',
          borderRadius: 3,
          bgcolor: 'rgba(10,16,30,0.95)',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)'
        }}
      >
        <Box
          sx={{
            width: { xs: '100%', md: 360 },
            borderRight: { md: '1px solid rgba(125,157,214,0.18)' },
            bgcolor: 'rgba(12,20,36,0.92)',
            display: selectedConv ? { xs: 'none', md: 'block' } : 'block'
          }}
        >
          <Box sx={{ p: 1.5, bgcolor: 'rgba(17,28,48,0.92)', borderBottom: '1px solid rgba(125,157,214,0.18)' }}>
            <Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#e9edef' }}>
              Conversaciones
            </Typography>
          </Box>

          <Box sx={{ p: 1, bgcolor: 'rgba(12,20,36,0.92)' }}>
            <TextField
              fullWidth
              size='small'
              placeholder='Buscar conversacin o contacto'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              InputProps={{
                startAdornment: <SearchIcon sx={{ mr: 1, color: '#8696a0' }} fontSize='small' />
              }}
              sx={{
                '& .MuiInputBase-root': {
                  bgcolor: 'rgba(17,28,48,0.92)',
                  color: '#d1d7db',
                  borderRadius: 2
                },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
                '& .MuiInputBase-root:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#2a3942' },
                '& .MuiInputBase-root.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#5BB2FF' }
              }}
            />
          </Box>
          <Divider sx={{ borderColor: '#2a3942' }} />

          {loadingTickets ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} sx={{ color: '#5BB2FF' }} />
            </Box>
          ) : filtered.length === 0 ? (
            <Typography variant='body2' sx={{ p: 2, color: '#8696a0' }}>
              No hay conversaciones.
            </Typography>
          ) : (
            <List dense sx={{ maxHeight: 'calc(100% - 120px)', overflow: 'auto', p: 0 }}>
              {filtered.map((c) => (
                <ListItemButton
                  key={c.contactId}
                  selected={selectedConv?.contactId === c.contactId}
                  onClick={() => handleSelect(c)}
                  sx={{
                    py: 1.2,
                    px: 1.5,
                    borderBottom: '1px solid rgba(125,157,214,0.14)',
                    '&.Mui-selected': { bgcolor: '#2a3942' },
                    '&:hover': { bgcolor: 'rgba(17,28,48,0.92)' }
                  }}
                >
                  <Avatar sx={{ width: 40, height: 40, mr: 1.2, bgcolor: '#3b4a54', color: '#e9edef' }}>
                    {(c.name || '?').slice(0, 1).toUpperCase()}
                  </Avatar>
                  <ListItemText
                    primary={
                      <Stack direction='row' justifyContent='space-between' alignItems='center'>
                        <Typography variant='body2' sx={{ fontWeight: 600, color: '#e9edef' }}>
                          {c.name}
                        </Typography>
                        <Typography variant='caption' sx={{ color: '#8696a0' }}>
                          {fmtTime(c.updatedAt)}
                        </Typography>
                      </Stack>
                    }
                    secondary={
                      <Stack direction='row' justifyContent='space-between' alignItems='center'>
                        <Typography variant='caption' noWrap sx={{ maxWidth: 180, color: '#8696a0' }}>
                          {c.lastMessage || c.number}
                        </Typography>
                        <Badge
                          color='success'
                          badgeContent={c.ticketCount > 99 ? '99+' : c.ticketCount}
                          sx={{ '& .MuiBadge-badge': { bgcolor: '#5BB2FF', color: '#0b141a' } }}
                        />
                      </Stack>
                    }
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>

        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            bgcolor: 'rgba(10,16,30,0.95)',
            backgroundImage:
              'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), radial-gradient(rgba(255,255,255,0.02) 1px, transparent 1px)',
            backgroundPosition: '0 0, 20px 20px',
            backgroundSize: '40px 40px'
          }}
        >
          {!selectedConv ? (
            <Box sx={{ m: 'auto', textAlign: 'center', color: '#8696a0' }}>
              <Typography variant='h6' sx={{ color: '#e9edef' }}>
                Seleccioná una conversación
              </Typography>
            </Box>
          ) : (
            <>
              <Box
                sx={{
                  p: 1.2,
                  bgcolor: 'rgba(17,28,48,0.92)',
                  borderBottom: '1px solid rgba(125,157,214,0.18)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <Stack direction='row' spacing={1.2} alignItems='center'>
                  <Avatar sx={{ bgcolor: '#3b4a54', color: '#e9edef' }}>
                    {(selectedConv.name || '?').slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Box>
                    <Typography variant='body2' sx={{ fontWeight: 600, color: '#e9edef' }}>
                      {selectedConv.name}
                    </Typography>
                    <Typography variant='caption' sx={{ color: '#8696a0' }}>
                      {selectedConv.number}
                    </Typography>
                  </Box>
                </Stack>
                <Stack direction='row' spacing={0.6}>
                  {selectedConv.statuses.slice(0, 2).map((s) => (
                    <Chip key={s} size='small' label={s} color={statusColor(s)} />
                  ))}
                  <IconButton onClick={() => fetchConversationMessages(selectedConv.contactId)} size='small' sx={{ color: '#e9edef' }}>
                    <RefreshIcon fontSize='small' />
                  </IconButton>
                </Stack>
              </Box>

              <Stack spacing={1} sx={{ flex: 1, overflow: 'auto', p: 2 }}>
                {loadingMessages ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress size={24} sx={{ color: '#5BB2FF' }} />
                  </Box>
                ) : messages.length === 0 ? (
                  <Typography variant='body2' sx={{ color: '#8696a0' }}>
                    No hay mensajes.
                  </Typography>
                ) : (
                  messages.map((m: any) => (
                    <Box
                      key={m.id || `${m.createdAt}-${m.body}`}
                      sx={{ display: 'flex', justifyContent: m.fromMe ? 'flex-end' : 'flex-start' }}
                    >
                      <Paper
                        variant='outlined'
                        sx={{
                          p: 1.1,
                          px: 1.2,
                          maxWidth: '78%',
                          borderRadius: 2,
                          bgcolor: m.fromMe ? '#005c4b' : '#202c33',
                          color: '#e9edef',
                          borderColor: 'rgba(255,255,255,0.12)'
                        }}
                      >
                        {(() => {
                          const mediaUrl = sanitizeUrl(String(m.mediaUrl || extractFirstUrl(m.body) || '').trim());
                          const mt = String(m.mediaType || '').toLowerCase();
                          return (
                            <>
                              {mt === 'image' && isHttpUrl(mediaUrl) && (
                                <Box component='img' src={mediaUrl} alt='media' sx={{ maxWidth: 280, borderRadius: 1, mb: 0.6 }} />
                              )}
                              {mt === 'video' && isHttpUrl(mediaUrl) && (
                                <Box component='video' src={mediaUrl} controls sx={{ maxWidth: 320, borderRadius: 1, mb: 0.6 }} />
                              )}
                              {mt === 'audio' && isHttpUrl(mediaUrl) && (
                                <Box component='audio' src={mediaUrl} controls sx={{ width: 260, mb: 0.6 }} />
                              )}
                              <Typography variant='body2' sx={{ whiteSpace: 'pre-wrap' }}>
                                {(() => {
                                  const raw = String(m.body || '').trim();
                                  const mtpl = raw.match(/^\[TEMPLATE:([^\]]+)\]/i);
                                  if (mtpl) return ` Template enviado: ${mtpl[1]}`;
                                  return raw || (m.mediaType && m.mediaType !== 'chat' ? `[${String(m.mediaType).toUpperCase()}]` : 'Mensaje sin contenido');
                                })()}
                              </Typography>
                              {isHttpUrl(mediaUrl) && (() => {
                                const p = linkPreviews[mediaUrl] || {};
                                const title = String(p.title || '').trim();
                                const desc = String(p.description || '').trim();
                                const host = String(p.host || (() => { try { return new URL(mediaUrl).hostname; } catch { return ''; } })()).trim();
                                const image = normalizePreviewImageUrl(String(p.image || '').trim(), mediaUrl);
                                const fallbackImage = fallbackPreviewImageUrl(mediaUrl);
                                const previewImage = image || fallbackImage;
                                return (
                                  <Box sx={{ mt: 0.8, border: '1px solid rgba(255,255,255,0.16)', borderRadius: 1.5, overflow: 'hidden', bgcolor: 'rgba(0,0,0,0.12)' }}>
                                    {previewImage && <Box component='img' src={previewImage} alt='preview' sx={{ width: '100%', maxHeight: 180, objectFit: 'cover' }} /> }
                                    <Box sx={{ p: 1 }}>
                                      {title && <Typography variant='body2' sx={{ fontWeight: 700 }}>{title}</Typography>}
                                      {desc && <Typography variant='caption' sx={{ color: '#b8c7cf', display: 'block' }}>{desc}</Typography>}
                                      <a href={mediaUrl} target='_blank' rel='noreferrer' style={{ color: '#7cd4ff', fontSize: 12 }}>{host || 'Abrir enlace'}</a>
                                    </Box>
                                  </Box>
                                );
                              })()}
                              <Typography variant='caption' sx={{ mt: 0.5, display: 'block', textAlign: 'right', color: 'rgba(233,237,239,0.72)' }}>
                                {fmtTime(m.createdAt)}
                              </Typography>
                            </>
                          );
                        })()}
                      </Paper>
                    </Box>
                  ))
                )}
                <div ref={messagesEndRef} />
              </Stack>

              <Box sx={{ p: 1.2, bgcolor: 'rgba(17,28,48,0.92)', borderTop: '1px solid #2a3942' }}>
                {savedReplies.length > 0 && (
                  <Stack direction='row' spacing={0.8} sx={{ mb: 1, overflowX: 'auto', pb: 0.5 }}>
                    {savedReplies.slice(0, 8).map((r) => (
                      <Chip
                        key={r.id}
                        size='small'
                        label={r.shortcut}
                        onClick={() => setText((t) => (t ? `${t} ${r.message}` : r.message))}
                        sx={{ bgcolor: '#2a3942', color: '#e9edef', border: '1px solid #3b4a54' }}
                      />
                    ))}
                  </Stack>
                )}
                <Stack direction='row' spacing={1} alignItems='center'>
                  <Tooltip title='Templates'>
                    <span>
                      <IconButton onClick={openTemplateMenu} disabled={sending || templates.length === 0} sx={{ color: '#e9edef' }}>
                        <TemplateIcon />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Menu anchorEl={templateMenuAnchor} open={Boolean(templateMenuAnchor)} onClose={closeTemplateMenu}>
                    {templates.length === 0 ? (
                      <MenuItem disabled>No hay templates</MenuItem>
                    ) : (
                      templates.map((tpl) => (
                        <MenuItem key={tpl.id} onClick={() => sendTemplateQuick(tpl)}>{tpl.name}</MenuItem>
                      ))
                    )}
                  </Menu>

                  <TextField
                    fullWidth
                    multiline
                    maxRows={4}
                    minRows={1}
                    placeholder='Escribí un mensaje'
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={sending}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    sx={{
                      '& .MuiInputBase-root': {
                        bgcolor: '#2a3942',
                        color: '#e9edef',
                        borderRadius: 3
                      },
                      '& .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
                      '& .MuiInputBase-root:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#3b4a54' },
                      '& .MuiInputBase-root.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#5BB2FF' }
                    }}
                  />
                  <IconButton onClick={handleSend} disabled={sending || !text.trim()} sx={{ width: 50, height: 50, borderRadius: '50%', bgcolor: '#5BB2FF', color: '#ffffff', boxShadow: '0 6px 14px rgba(34,166,242,0.35)', '&:hover': { bgcolor: '#4B9BE0' }, '&.Mui-disabled': { bgcolor: '#2D405A', color: '#9bb2c3' } }}>
                    {sending ? <CircularProgress size={20} color='inherit' /> : <SendIcon />}
                  </IconButton>
                </Stack>
              </Box>
            </>
          )}
        </Box>

        {selectedConv && (
          <Box sx={{ width: 320, borderLeft: '1px solid #202c33', bgcolor: 'rgba(12,20,36,0.92)', p: 1.2, display: { xs: 'none', lg: 'block' }, overflow: 'auto' }}>
            <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1 }}>
              <Typography variant='subtitle1' sx={{ color: '#e9edef', fontWeight: 700 }}>
                Datos del cliente
              </Typography>
              <Stack direction='row' spacing={0.6} alignItems='center'>
                <Typography variant='caption' sx={{ color: '#9fb1bb', minWidth: 52, textAlign: 'right' }}>{isBotEnabled ? 'Bot ON' : 'Bot OFF'}</Typography>
                <Switch
                  size='small'
                  checked={isBotEnabled}
                  disabled={savingHandoff || !latestTicketId}
                  onChange={(_e, checked) => toggleHandoff(!checked)}
                  sx={{
                    '& .MuiSwitch-switchBase.Mui-checked': { color: '#2f7dfa' },
                    '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: '#2f7dfa' }
                  }}
                />
              </Stack>
            </Stack>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: 'rgba(17,28,48,0.92)', color: '#e9edef' }}>
              <FormControl fullWidth size='small'>
                <InputLabel sx={{ color: '#9fb1bb' }}>Estado del Lead</InputLabel>
                <Select
                  label='Estado del Lead'
                  value={leadStage}
                  disabled={savingLeadStage}
                  onChange={(e) => updateLeadStage(String(e.target.value))}
                  sx={{ color: '#e9edef' }}
                >
                  <MenuItem value='nuevo'>Nuevo</MenuItem>
                  <MenuItem value='contactado'>Contactado</MenuItem>
                  <MenuItem value='calificado'>Calificado</MenuItem>
                  <MenuItem value='interesado'>Interesado</MenuItem>
                </Select>
              </FormControl>

              <Box sx={{ mt: 1.2 }}>
                <Stack direction='row' justifyContent='space-between'>
                  <Typography variant='caption' sx={{ color: '#9fb1bb' }}>Puntuación</Typography>
                  <Typography variant='caption' sx={{ color: '#9fb1bb' }}>{leadScore}%</Typography>
                </Stack>
                <LinearProgress variant='determinate' value={Math.max(0, Math.min(100, leadScore))} sx={{ mt: 0.5, height: 8, borderRadius: 6 }} />
              </Box>
            </Paper>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: 'rgba(17,28,48,0.92)', color: '#e9edef' }}>
              <Typography variant='subtitle2' sx={{ mb: 1 }}>Progreso del paso</Typography>
              <Stack spacing={0.6}>
                <Stack direction='row' alignItems='center' justifyContent='space-between'>
                  <Stack direction='row' alignItems='center' spacing={0.6}>
                    <Checkbox
                      size='small'
                      checked={hasOpciones}
                      disabled={savingProgress}
                      onChange={() => toggleProgressTag('opciones_presentadas')}
                      sx={{ color: '#9fb1bb', '&.Mui-checked': { color: '#00a884' } }}
                    />
                    <Typography variant='caption'>opciones presentadas</Typography>
                  </Stack>
                </Stack>
                <Stack direction='row' alignItems='center' justifyContent='space-between'>
                  <Stack direction='row' alignItems='center' spacing={0.6}>
                    <Checkbox
                      size='small'
                      checked={hasInteres}
                      disabled={savingProgress}
                      onChange={() => toggleProgressTag('interes_detectado')}
                      sx={{ color: '#9fb1bb', '&.Mui-checked': { color: '#00a884' } }}
                    />
                    <Typography variant='caption'>interés detectado</Typography>
                  </Stack>
                </Stack>
              </Stack>
            </Paper>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: 'rgba(17,28,48,0.92)', color: '#e9edef' }}>
              <Typography variant='subtitle2' sx={{ mb: 1 }}>Datos capturados</Typography>
              <Typography variant='caption' display='block'>Nombre: {contactData?.name || selectedConv.name}</Typography>
              <Typography variant='caption' display='block'>Email: {contactData?.email || '-'}</Typography>
              <Typography variant='caption' display='block'>Teléfono: {contactData?.number || selectedConv.number}</Typography>
              <Typography variant='caption' display='block'>Rubro: {contactData?.business_type || '-'}</Typography>
              <Typography variant='caption' display='block'>Necesidad: {contactData?.needs || '-'}</Typography>
            </Paper>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: 'rgba(17,28,48,0.92)', color: '#e9edef' }}>
              <Typography variant='subtitle2' sx={{ mb: 1 }}>Mini resumen IA</Typography>
              <Typography variant='caption'>{summary}</Typography>
            </Paper>

            <Paper sx={{ p: 1.2, bgcolor: 'rgba(17,28,48,0.92)', color: '#e9edef' }}>
              <Typography variant='subtitle2' sx={{ mb: 1 }}>Trazabilidad de decisiones IA</Typography>
              {decisionLogs.length === 0 ? (
                <Typography variant='caption' sx={{ color: '#9fb1bb' }}>Sin decisiones registradas para este ticket.</Typography>
              ) : (
                <Stack spacing={0.8}>
                  {decisionLogs.slice(0, 10).map((d: any) => (
                    <Box key={d.id} sx={{ border: '1px solid #2a3942', borderRadius: 1.5, p: 0.8 }}>
                      <Stack direction='row' justifyContent='space-between'>
                        <Chip size='small' label={`${d.conversation_type || 'general'} · ${d.decision_key || 'decision'}`} />
                        <Typography variant='caption' sx={{ color: '#9fb1bb' }}>{fmtTime(d.created_at)}</Typography>
                      </Stack>
                      <Typography variant='caption' display='block' sx={{ mt: 0.5 }}>Motivo: {d.reason || '-'}</Typography>
                      <Typography variant='caption' display='block'>Acción: {d.guardrail_action || '-'}</Typography>
                      <Typography variant='caption' display='block' sx={{ color: '#9fb1bb' }}>Preview: {d.response_preview || '-'}</Typography>
                    </Box>
                  ))}
                </Stack>
              )}
            </Paper>
          </Box>
        )}
      </Paper>
    </Box>
  );
};

export default Conversations;

