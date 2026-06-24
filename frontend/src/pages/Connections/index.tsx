import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Stack, Button, Chip, IconButton, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Select, MenuItem, FormControl,
  InputLabel, CircularProgress, InputAdornment, Paper, Tooltip,
} from '@mui/material';
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon,
  ContentCopy as CopyIcon, CheckCircle as CheckIcon,
  Cancel as CancelIcon, Refresh as TestIcon,
  Visibility, VisibilityOff,
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const CHANNEL_META: Record<string, { label: string; color: string; icon: string; fields: string[] }> = {
  whatsapp:  { label: 'WhatsApp',  color: '#25D366', icon: 'W', fields: ['Phone Number ID', 'Access Token', 'App Secret'] },
  instagram: { label: 'Instagram', color: '#E1306C', icon: 'I', fields: ['IG Account ID', 'Access Token'] },
  messenger: { label: 'Messenger', color: '#0084FF', icon: 'M', fields: ['Page ID', 'Access Token'] },
};

const WEBHOOK_URL = `${window.location.origin}/webhooks/meta`;

const copyText = (text: string, label: string) => {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copiado`);
};

interface Channel {
  id: number;
  channel_type: string;
  name: string;
  status: string;
  external_id: string;
  verify_token: string;
  has_token: boolean;
  created_at: string;
}

const Connections = () => {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; data?: any; error?: string }>>({});

  const [formType, setFormType] = useState('whatsapp');
  const [formName, setFormName] = useState('');
  const [formExternalId, setFormExternalId] = useState('');
  const [formToken, setFormToken] = useState('');
  const [formAppSecret, setFormAppSecret] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);

  const companyVerifyToken = channels.find((c) => c.verify_token)?.verify_token || '';

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/channels');
      setChannels(data.channels || []);
    } catch {
      toast.error('No se pudieron cargar los canales');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setEditing(null);
    setFormType('whatsapp');
    setFormName('');
    setFormExternalId('');
    setFormToken('');
    setFormAppSecret('');
    setDialogOpen(true);
  };

  const openEdit = (ch: Channel) => {
    setEditing(ch);
    setFormType(ch.channel_type);
    setFormName(ch.name);
    setFormExternalId(ch.external_id);
    setFormToken('');
    setFormAppSecret('');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/channels/${editing.id}`, {
          name: formName || undefined,
          external_id: formExternalId || undefined,
          access_token: formToken || undefined,
          app_secret: formAppSecret || undefined,
        });
        toast.success('Canal actualizado');
      } else {
        await api.post('/channels', {
          channel_type: formType,
          name: formName || CHANNEL_META[formType]?.label || formType,
          external_id: formExternalId,
          access_token: formToken,
          app_secret: formAppSecret,
        });
        toast.success('Canal creado');
      }
      setDialogOpen(false);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ch: Channel) => {
    if (!confirm(`¿Desactivar canal "${ch.name}"?`)) return;
    try {
      await api.delete(`/channels/${ch.id}`);
      toast.success('Canal desactivado');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al desactivar');
    }
  };

  const handleTest = async (ch: Channel) => {
    setTestResults(prev => ({ ...prev, [ch.id]: { ok: false, error: 'testing...' } }));
    try {
      const { data } = await api.post(`/channels/${ch.id}/test`);
      setTestResults(prev => ({ ...prev, [ch.id]: data }));
      if (data.ok) toast.success(`${ch.name}: conexión verificada`);
      else toast.error(`${ch.name}: ${data.error || 'error'}`);
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [ch.id]: { ok: false, error: e?.response?.data?.detail || 'Error' } }));
      toast.error('Error al testear');
    }
  };

  const meta = (type: string) => CHANNEL_META[type] || { label: type, color: '#888', icon: '?', fields: [] };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: '#E8A020' }} /></Box>;
  }

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2' }}>
            Canales
          </Typography>
          <Typography sx={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.4)' }}>
            WhatsApp, Instagram y Messenger conectados a tu CRM
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} sx={{ fontSize: '0.82rem' }}>
          Agregar canal
        </Button>
      </Stack>

      {/* Webhook panel */}
      <Paper sx={{ p: 2, mb: 3, borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <Typography sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', mb: 1, fontWeight: 600 }}>Configuración del webhook (Meta Developers)</Typography>

        {/* Callback URL */}
        <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 0.5, mb: 0.3 }}>Callback URL</Typography>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace', color: '#E8A020', flexGrow: 1, wordBreak: 'break-all' }}>
            {WEBHOOK_URL}
          </Typography>
          <IconButton size="small" onClick={() => copyText(WEBHOOK_URL, 'Callback URL')}><CopyIcon sx={{ fontSize: 14 }} /></IconButton>
        </Stack>

        {/* Verify token (one per company) */}
        {companyVerifyToken && (
          <>
            <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 0.5, mb: 0.3 }}>Verify Token</Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace', color: '#34D399', flexGrow: 1, wordBreak: 'break-all' }}>
                {companyVerifyToken}
              </Typography>
              <IconButton size="small" onClick={() => copyText(companyVerifyToken, 'Verify Token')}><CopyIcon sx={{ fontSize: 14 }} /></IconButton>
            </Stack>
          </>
        )}

        <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', mt: 1 }}>
          Una sola URL y un solo verify token para todos tus canales (WhatsApp, Instagram, Messenger). Se genera automáticamente al crear el primer canal.
        </Typography>
      </Paper>

      {/* Channels list */}
      {channels.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Typography sx={{ color: 'rgba(255,255,255,0.4)', mb: 2 }}>No hay canales configurados</Typography>
          <Button variant="outlined" onClick={openCreate}>Agregar primer canal</Button>
        </Paper>
      ) : (
        <Stack spacing={1.5}>
          {channels.map((ch, i) => {
            const m = meta(ch.channel_type);
            const test = testResults[ch.id];
            return (
              <Paper
                key={ch.id}
                className={`anim-fade-up anim-fade-up-${i}`}
                sx={{
                  p: 2, borderRadius: '10px',
                  background: 'rgba(255,255,255,0.02)',
                  border: `1px solid ${ch.status === 'active' ? 'rgba(255,255,255,0.06)' : 'rgba(239,83,80,0.15)'}`,
                  transition: 'border-color 200ms ease',
                  '&:hover': { borderColor: `${m.color}33` },
                }}
              >
                <Stack direction="row" alignItems="center" spacing={2}>
                  {/* Icon */}
                  <Box sx={{
                    width: 40, height: 40, borderRadius: '10px',
                    background: `${m.color}18`, border: `1px solid ${m.color}30`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '1rem', color: m.color,
                  }}>
                    {m.icon}
                  </Box>

                  {/* Info */}
                  <Box sx={{ flexGrow: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography sx={{ fontWeight: 600, fontSize: '0.9rem', color: '#E8EBF2' }}>{ch.name}</Typography>
                      <Chip
                        size="small"
                        label={ch.status === 'active' ? 'Activo' : ch.status}
                        sx={{
                          height: 20, fontSize: '0.65rem', fontWeight: 600,
                          backgroundColor: ch.status === 'active' ? 'rgba(52,211,153,0.12)' : 'rgba(239,83,80,0.12)',
                          color: ch.status === 'active' ? '#34D399' : '#EF5350',
                        }}
                      />
                      {test && (
                        <Chip
                          size="small"
                          icon={test.ok ? <CheckIcon sx={{ fontSize: '12px !important' }} /> : <CancelIcon sx={{ fontSize: '12px !important' }} />}
                          label={test.ok ? 'Conectado' : (test.error === 'testing...' ? 'Verificando...' : 'Error')}
                          sx={{
                            height: 20, fontSize: '0.65rem',
                            backgroundColor: test.ok ? 'rgba(52,211,153,0.12)' : 'rgba(239,83,80,0.12)',
                            color: test.ok ? '#34D399' : '#EF5350',
                          }}
                        />
                      )}
                    </Stack>
                    <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', fontFamily: '"JetBrains Mono", monospace' }}>
                      {m.label} &middot; {ch.external_id}
                    </Typography>
                  </Box>

                  {/* Verify token */}
                  {ch.verify_token && (
                    <Tooltip title="Copiar Verify Token">
                      <IconButton size="small" onClick={() => copyText(ch.verify_token, 'Verify Token')}>
                        <CopyIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  )}

                  {/* Actions */}
                  <Tooltip title="Probar conexión"><IconButton size="small" onClick={() => handleTest(ch)}><TestIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                  <Tooltip title="Editar"><IconButton size="small" onClick={() => openEdit(ch)}><EditIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                  <Tooltip title="Desactivar"><IconButton size="small" onClick={() => handleDelete(ch)}><DeleteIcon sx={{ fontSize: 16, color: 'rgba(239,83,80,0.6)' }} /></IconButton></Tooltip>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700 }}>
          {editing ? 'Editar canal' : 'Agregar canal'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {!editing && (
              <FormControl fullWidth size="small">
                <InputLabel>Tipo de canal</InputLabel>
                <Select value={formType} label="Tipo de canal" onChange={e => setFormType(e.target.value)}>
                  <MenuItem value="whatsapp">WhatsApp Cloud API</MenuItem>
                  <MenuItem value="instagram">Instagram DMs</MenuItem>
                  <MenuItem value="messenger">Facebook Messenger</MenuItem>
                </Select>
              </FormControl>
            )}

            <TextField
              size="small" fullWidth
              label="Nombre del canal"
              placeholder={meta(formType).label}
              value={formName}
              onChange={e => setFormName(e.target.value)}
              helperText="Nombre para identificar este canal (ej: WhatsApp Principal, IG Empresa)"
            />

            <TextField
              size="small" fullWidth required
              label={formType === 'whatsapp' ? 'Phone Number ID' : formType === 'instagram' ? 'IG Account ID' : 'Page ID'}
              value={formExternalId}
              onChange={e => setFormExternalId(e.target.value)}
              helperText={
                formType === 'whatsapp'
                  ? 'Lo encontrás en Meta Developers → WhatsApp → Configuración de API'
                  : formType === 'instagram'
                  ? 'ID de la cuenta profesional de Instagram'
                  : 'ID de la página de Facebook'
              }
            />

            <TextField
              size="small" fullWidth
              label="Access Token"
              type={showSecrets ? 'text' : 'password'}
              value={formToken}
              onChange={e => setFormToken(e.target.value)}
              helperText={editing ? 'Dejá en blanco para mantener el actual' : ''}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setShowSecrets(!showSecrets)}>
                      {showSecrets ? <VisibilityOff sx={{ fontSize: 16 }} /> : <Visibility sx={{ fontSize: 16 }} />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />

            {formType === 'whatsapp' && (
              <TextField
                size="small" fullWidth
                label="App Secret"
                type={showSecrets ? 'text' : 'password'}
                value={formAppSecret}
                onChange={e => setFormAppSecret(e.target.value)}
                helperText="Recomendado para verificar firmas de webhook"
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancelar</Button>
          <Button variant="contained" onClick={handleSave} disabled={saving || !formExternalId.trim()}>
            {saving ? <CircularProgress size={18} /> : editing ? 'Guardar' : 'Crear canal'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Connections;
