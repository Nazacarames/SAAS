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

const parsePropertyCards = (body: string): Array<{ photo: string | null; text: string }> | null => {
  const CARD_SEP = ' ||| ';
  if (!body.includes('[FOTO:') && !body.includes(CARD_SEP)) return null;
  const pin = '\u{1F4CD}'; // 📍
  const cardStart = body.indexOf(pin);
  let bodyPart: string;
  if (cardStart >= 0) {
    bodyPart = body.slice(cardStart);
  } else if (body.toLowerCase().startsWith('te paso opciones concretas:')) {
    bodyPart = body.split(':').slice(1).join(':').trim();
  } else {
    return null;
  }
  const rawItems = bodyPart.split(CARD_SEP).map((s) => s.trim()).filter(Boolean);
  if (rawItems.length === 0) return null;
  return rawItems.map((item) => {
    const photoMatch = item.match(/\[FOTO:(https?:\/\/[^\]]+)\]/);
    const photo = photoMatch ? photoMatch[1] : null;
    const text = item.replace(/\s*\[FOTO:https?:\/\/[^\]]+\]\s*/g, '').trim();
    return { photo, text };
  });
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

    const handleNewMessage = (data: any) => {
        fetchTickets();
        if (selectedConv && Number(data?.contactId) === selectedConv.contactId) {
            fetchConversationMessages(selectedConv.contactId);
        }
    };

    const handleTicketUpdate = () => {
        fetchTickets();
    };

    if (socket) {
        socket.on('newMessage', handleNewMessage);
        socket.on('ticketUpdate', handleTicketUpdate);
        socket.on('contactUpdate', handleTicketUpdate);
    }

    return () => {
        if (socket) {
            socket.off('newMessage', handleNewMessage);
            socket.off('ticketUpdate', handleTicketUpdate);
            socket.off('contactUpdate', handleTicketUpdate);
        }
    };
  }, [selectedConv?.contactId]);

  useEffect(() => {
    // Jittered interval (25-35s) so simultaneously-open clients don't all
    // poll the backend at the same aligned moment (thundering herd).
    const period = 25000 + Math.floor(Math.random() * 10000);
    const id = setInterval(() => { fetchTickets(); }, period);
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
  // Backend owns the stage mapping (lead_stage column); local thresholds are
  // only a fallback for stale API responses.
  const leadStage = contactData?.lead_stage || stageFromScore(leadScore);
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

  const progressTags: string[] = (contactData?.progress_tags || []).map((t: string) => t.toLowerCase());
  const hasOpciones = progressTags.includes('opciones_presentadas');
  const hasInteres = progressTags.includes('interes_detectado');

  const toggleProgressTag = async (tag: string) => {
    if (!selectedConv?.contactId) return;
    setSavingProgress(true);
    try {
      const current: string[] = (contactData?.progress_tags || []).map((t: string) => t.toLowerCase());
      const exists = current.includes(tag.toLowerCase());
      const next = exists
        ? current.filter((x: string) => x !== tag.toLowerCase())
        : [...current, tag.toLowerCase()];

      await api.put(`/contacts/${selectedConv.contactId}`, {
        progress_tags: next
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
          borderRadius: '14px',
          bgcolor: '#0C0E12',
          border: '1px solid rgba(232,160,32,0.12)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)'
        }}
      >
        <Box
          sx={{
            width: { xs: '100%', md: 360 },
            borderRight: { md: '1px solid rgba(232,160,32,0.12)' },
            bgcolor: '#13161C',
            display: selectedConv ? { xs: 'none', md: 'block' } : 'block'
          }}
        >
          <Box sx={{ p: 1.5, bgcolor: '#1A1D24', borderBottom: '1px solid rgba(232,160,32,0.12)' }}>
            <Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#E8E6E1', fontFamily: '"Syne", sans-serif', letterSpacing: '-0.02em', fontSize: '0.95rem' }}>
              Conversaciones
            </Typography>
          </Box>

          <Box sx={{ p: 1, bgcolor: '#13161C' }}>
            <TextField
              fullWidth
              size='small'
              placeholder='Buscar conversacin o contacto'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              InputProps={{
                startAdornment: <SearchIcon sx={{ mr: 1, color: '#7A7872' }} fontSize='small' />
              }}
              sx={{
                '& .MuiInputBase-root': {
                  bgcolor: '#1A1D24',
                  color: '#d1d7db',
                  borderRadius: 2
                },
                '& .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
                '& .MuiInputBase-root:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(232,160,32,0.1)' },
                '& .MuiInputBase-root.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#E8A020' }
              }}
            />
          </Box>
          <Divider sx={{ borderColor: 'rgba(232,160,32,0.1)' }} />

          {loadingTickets ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
              <CircularProgress size={24} sx={{ color: '#E8A020' }} />
            </Box>
          ) : filtered.length === 0 ? (
            <Typography variant='body2' sx={{ p: 2, color: '#7A7872' }}>
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
                    borderBottom: '1px solid rgba(232,160,32,0.08)',
                    '&.Mui-selected': { bgcolor: 'rgba(232,160,32,0.1)' },
                    '&:hover': { bgcolor: '#1A1D24' }
                  }}
                >
                  <Avatar sx={{ width: 40, height: 40, mr: 1.2, bgcolor: 'rgba(232,160,32,0.14)', color: '#E8A020' }}>
                    {(c.name || '?').slice(0, 1).toUpperCase()}
                  </Avatar>
                  <ListItemText
                    primary={
                      <Stack direction='row' justifyContent='space-between' alignItems='center'>
                        <Typography variant='body2' sx={{ fontWeight: 600, color: '#E8E6E1' }}>
                          {c.name}
                        </Typography>
                        <Typography variant='caption' sx={{ color: '#7A7872', fontFamily: '"JetBrains Mono", monospace', fontSize: '0.6rem' }}>
                          {fmtTime(c.updatedAt)}
                        </Typography>
                      </Stack>
                    }
                    secondary={
                      <Stack direction='row' justifyContent='space-between' alignItems='center'>
                        <Typography variant='caption' noWrap sx={{ maxWidth: 180, color: '#7A7872' }}>
                          {c.lastMessage || c.number}
                        </Typography>
                        <Badge
                          color='success'
                          badgeContent={c.ticketCount > 99 ? '99+' : c.ticketCount}
                          sx={{ '& .MuiBadge-badge': { bgcolor: '#E8A020', color: '#0b141a' } }}
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
            bgcolor: '#0C0E12',
            backgroundImage:
              'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), radial-gradient(rgba(255,255,255,0.02) 1px, transparent 1px)',
            backgroundPosition: '0 0, 20px 20px',
            backgroundSize: '40px 40px'
          }}
        >
          {!selectedConv ? (
            <Box sx={{ m: 'auto', textAlign: 'center', color: '#7A7872' }}>
              <Typography variant='h6' sx={{ color: '#E8E6E1' }}>
                Seleccioná una conversación
              </Typography>
            </Box>
          ) : (
            <>
              <Box
                sx={{
                  p: 1.2,
                  bgcolor: '#1A1D24',
                  borderBottom: '1px solid rgba(232,160,32,0.12)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}
              >
                <Stack direction='row' spacing={1.2} alignItems='center'>
                  <Avatar sx={{ bgcolor: 'rgba(232,160,32,0.14)', color: '#E8A020' }}>
                    {(selectedConv.name || '?').slice(0, 1).toUpperCase()}
                  </Avatar>
                  <Box>
                    <Typography variant='body2' sx={{ fontWeight: 600, color: '#E8E6E1' }}>
                      {selectedConv.name}
                    </Typography>
                    <Typography variant='caption' sx={{ color: '#7A7872', fontFamily: '"JetBrains Mono", monospace', fontSize: '0.65rem' }}>
                      {selectedConv.number}
                    </Typography>
                  </Box>
                </Stack>
                <Stack direction='row' spacing={0.6}>
                  {selectedConv.statuses.slice(0, 2).map((s) => (
                    <Chip key={s} size='small' label={s} color={statusColor(s)} />
                  ))}
                  <IconButton onClick={() => fetchConversationMessages(selectedConv.contactId)} size='small' sx={{ color: '#E8E6E1' }}>
                    <RefreshIcon fontSize='small' />
                  </IconButton>
                </Stack>
              </Box>

              <Stack spacing={1} sx={{ flex: 1, overflow: 'auto', p: 2 }}>
                {loadingMessages ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress size={24} sx={{ color: '#E8A020' }} />
                  </Box>
                ) : messages.length === 0 ? (
                  <Typography variant='body2' sx={{ color: '#7A7872' }}>
                    No hay mensajes.
                  </Typography>
                ) : (
                  messages.map((m) => {
                    const propCards = m.fromMe ? parsePropertyCards(String(m.body || '')) : null;
                    if (propCards && propCards.length > 0) {
                      return (
                        <Box key={m.id || `${m.createdAt}-${m.body}`} className='msg-in' sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.8 }}>
                          {propCards.map((card, ci) => (
                            <Paper
                              key={ci}
                              variant='outlined'
                              sx={{ maxWidth: '78%', borderRadius: 2, bgcolor: 'rgba(232,160,32,0.1)', color: '#E8E6E1', borderColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}
                            >
                              {card.photo && isHttpUrl(card.photo) && (
                                <Box component='img' src={card.photo} alt='propiedad' sx={{ width: '100%', maxHeight: 200, objectFit: 'cover', display: 'block' }} />
                              )}
                              <Box sx={{ p: 1.1, px: 1.2 }}>
                                <Typography variant='body2' sx={{ whiteSpace: 'pre-wrap' }}>{card.text}</Typography>
                                {ci === propCards.length - 1 && (
                                  <Typography variant='caption' sx={{ mt: 0.5, display: 'block', textAlign: 'right', color: 'rgba(233,237,239,0.72)' }}>
                                    {fmtTime(m.createdAt)}
                                  </Typography>
                                )}
                              </Box>
                            </Paper>
                          ))}
                        </Box>
                      );
                    }
                    return (
                    <Box
                      key={m.id || `${m.createdAt}-${m.body}`}
                      className='msg-in'
                      sx={{ display: 'flex', justifyContent: m.fromMe ? 'flex-end' : 'flex-start' }}
                    >
                      <Paper
                        variant='outlined'
                        sx={{
                          p: 1.1,
                          px: 1.2,
                          maxWidth: '78%',
                          borderRadius: 2,
                          bgcolor: m.fromMe ? 'rgba(232,160,32,0.12)' : '#1A1D24',
                          color: '#E8E6E1',
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
                                  <Box sx={{ mt: 0.8, border: '1px solid rgba(232,160,32,0.15)', borderRadius: 1.5, overflow: 'hidden', bgcolor: 'rgba(255,255,255,0.03)' }}>
                                    {previewImage && <Box component='img' src={previewImage} alt='preview' sx={{ width: '100%', maxHeight: 180, objectFit: 'cover' }} /> }
                                    <Box sx={{ p: 1 }}>
                                      {title && <Typography variant='body2' sx={{ fontWeight: 700 }}>{title}</Typography>}
                                      {desc && <Typography variant='caption' sx={{ color: '#b8c7cf', display: 'block' }}>{desc}</Typography>}
                                      <a href={mediaUrl} target='_blank' rel='noreferrer' style={{ color: '#E8A020', fontSize: 12 }}>{host || 'Abrir enlace'}</a>
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
                    );
                  })
                )}
              </Stack>

              <Box sx={{ p: 1.2, bgcolor: '#1A1D24', borderTop: '1px solid #2a3942' }}>
                {savedReplies.length > 0 && (
                  <Stack direction='row' spacing={0.8} sx={{ mb: 1, overflowX: 'auto', pb: 0.5 }}>
                    {savedReplies.slice(0, 8).map((r) => (
                      <Chip
                        key={r.id}
                        size='small'
                        label={r.shortcut}
                        onClick={() => setText((t) => (t ? `${t} ${r.message}` : r.message))}
                        sx={{ bgcolor: 'rgba(232,160,32,0.1)', color: '#E8E6E1', border: '1px solid rgba(232,160,32,0.2)' }}
                      />
                    ))}
                  </Stack>
                )}
                <Stack direction='row' spacing={1} alignItems='center'>
                  <Tooltip title='Templates'>
                    <span>
                      <IconButton onClick={openTemplateMenu} disabled={sending || templates.length === 0} sx={{ color: '#E8E6E1' }}>
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
                        bgcolor: 'rgba(232,160,32,0.1)',
                        color: '#E8E6E1',
                        borderRadius: 3
                      },
                      '& .MuiOutlinedInput-notchedOutline': { borderColor: 'transparent' },
                      '& .MuiInputBase-root:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(232,160,32,0.2)' },
                      '& .MuiInputBase-root.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: '#E8A020' }
                    }}
                  />
                  <IconButton onClick={handleSend} disabled={sending || !text.trim()} sx={{ width: 50, height: 50, borderRadius: '50%', bgcolor: '#E8A020', color: '#0C0E12', boxShadow: '0 4px 16px rgba(232,160,32,0.3)', '&:hover': { bgcolor: '#CC8C1A', boxShadow: '0 4px 20px rgba(232,160,32,0.45)' }, '&.Mui-disabled': { bgcolor: 'rgba(232,160,32,0.15)', color: 'rgba(232,160,32,0.35)' } }}>
                    {sending ? <CircularProgress size={20} color='inherit' /> : <SendIcon />}
                  </IconButton>
                </Stack>
              </Box>
            </>
          )}
        </Box>

        {selectedConv && (
          <Box sx={{ width: 320, borderLeft: '1px solid rgba(232,160,32,0.1)', bgcolor: '#13161C', p: 1.2, display: { xs: 'none', lg: 'block' }, overflow: 'auto' }}>
            <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 1 }}>
              <Typography variant='subtitle1' sx={{ color: '#E8E6E1', fontWeight: 700, fontFamily: '"Syne", sans-serif', letterSpacing: '-0.02em' }}>
                Datos del cliente
              </Typography>
              <Stack direction='row' spacing={0.6} alignItems='center'>
                <Typography variant='caption' sx={{ color: '#7A7872', minWidth: 52, textAlign: 'right' }}>{isBotEnabled ? 'Bot ON' : 'Bot OFF'}</Typography>
                <Switch
                  size='small'
                  checked={isBotEnabled}
                  disabled={savingHandoff || !latestTicketId}
                  onChange={(_e, checked) => toggleHandoff(!checked)}
                  sx={{
                    '& .MuiSwitch-switchBase.Mui-checked': { color: '#E8A020' },
                    '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: '#E8A020' }
                  }}
                />
              </Stack>
            </Stack>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: '#1A1D24', color: '#E8E6E1' }}>
              <FormControl fullWidth size='small'>
                <InputLabel sx={{ color: '#7A7872' }}>Estado del Lead</InputLabel>
                <Select
                  label='Estado del Lead'
                  value={leadStage}
                  disabled={savingLeadStage}
                  onChange={(e) => updateLeadStage(String(e.target.value))}
                  sx={{ color: '#E8E6E1' }}
                >
                  <MenuItem value='nuevo'>Nuevo</MenuItem>
                  <MenuItem value='contactado'>Contactado</MenuItem>
                  <MenuItem value='calificado'>Calificado</MenuItem>
                  <MenuItem value='interesado'>Interesado</MenuItem>
                </Select>
              </FormControl>

              <Box sx={{ mt: 1.2 }}>
                <Stack direction='row' justifyContent='space-between'>
                  <Typography variant='caption' sx={{ color: '#7A7872' }}>Puntuación</Typography>
                  <Typography variant='caption' sx={{ color: '#7A7872' }}>{leadScore}%</Typography>
                </Stack>
                <LinearProgress variant='determinate' value={Math.max(0, Math.min(100, leadScore))} sx={{ mt: 0.5, height: 8, borderRadius: 6 }} />
              </Box>
            </Paper>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: '#1A1D24', color: '#E8E6E1' }}>
              <Typography variant='subtitle2' sx={{ mb: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#7A7872' }}>Progreso del paso</Typography>
              <Stack spacing={0.6}>
                <Stack direction='row' alignItems='center' justifyContent='space-between'>
                  <Stack direction='row' alignItems='center' spacing={0.6}>
                    <Checkbox
                      size='small'
                      checked={hasOpciones}
                      disabled={savingProgress}
                      onChange={() => toggleProgressTag('opciones_presentadas')}
                      sx={{ color: '#7A7872', '&.Mui-checked': { color: '#E8A020' } }}
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
                      sx={{ color: '#7A7872', '&.Mui-checked': { color: '#E8A020' } }}
                    />
                    <Typography variant='caption'>interés detectado</Typography>
                  </Stack>
                </Stack>
              </Stack>
            </Paper>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: '#1A1D24', color: '#E8E6E1' }}>
              <Typography variant='subtitle2' sx={{ mb: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#7A7872' }}>Datos capturados</Typography>
              <Typography variant='caption' display='block'>Nombre: {contactData?.name || selectedConv.name}</Typography>
              <Typography variant='caption' display='block'>Email: {contactData?.email || '-'}</Typography>
              <Typography variant='caption' display='block'>Teléfono: {contactData?.number || selectedConv.number}</Typography>
              <Typography variant='caption' display='block'>Rubro: {contactData?.business_type || '-'}</Typography>
              <Typography variant='caption' display='block'>Necesidad: {contactData?.needs || '-'}</Typography>
            </Paper>

            <Paper sx={{ p: 1.2, mb: 1.2, bgcolor: '#1A1D24', color: '#E8E6E1' }}>
              <Typography variant='subtitle2' sx={{ mb: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#7A7872' }}>Mini resumen IA</Typography>
              <Typography variant='caption'>{contactData?.needs?.trim() || summary}</Typography>
            </Paper>

            <Paper sx={{ p: 1.2, bgcolor: '#1A1D24', color: '#E8E6E1' }}>
              <Typography variant='subtitle2' sx={{ mb: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: '0.65rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#7A7872' }}>Trazabilidad de decisiones IA</Typography>
              {decisionLogs.length === 0 ? (
                <Typography variant='caption' sx={{ color: '#7A7872' }}>Sin decisiones registradas para este ticket.</Typography>
              ) : (
                <Stack spacing={0.8}>
                  {decisionLogs.slice(0, 10).map((d: any) => (
                    <Box key={d.id} sx={{ border: '1px solid rgba(232,160,32,0.1)', borderRadius: 1.5, p: 0.8 }}>
                      <Stack direction='row' justifyContent='space-between'>
                        <Chip size='small' label={`${d.conversation_type || 'general'} · ${d.decision_key || 'decision'}`} />
                        <Typography variant='caption' sx={{ color: '#7A7872' }}>{fmtTime(d.created_at)}</Typography>
                      </Stack>
                      <Typography variant='caption' display='block' sx={{ mt: 0.5 }}>Motivo: {d.reason || '-'}</Typography>
                      <Typography variant='caption' display='block'>Acción: {d.guardrail_action || '-'}</Typography>
                      <Typography variant='caption' display='block' sx={{ color: '#7A7872' }}>Preview: {d.response_preview || '-'}</Typography>
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

