import { useEffect, useState, useCallback } from 'react';
import {
  Box, Typography, Stack, IconButton, Button, Dialog, DialogTitle, DialogContent,
  DialogActions, TextField, Menu, MenuItem, CircularProgress, Avatar, Chip,
} from '@mui/material';
import {
  Add as AddIcon, MoreVert as MoreIcon, Edit as EditIcon, Delete as DeleteIcon,
  ChevronLeft, ChevronRight,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../../services/api';

const STAGE_COLORS = ['#4FC3F7', '#E8A020', '#A78BFA', '#FB923C', '#34D399', '#EF5350', '#EC4899', '#22D3EE', '#94A3B8'];
const CHANNEL_COLOR: Record<string, string> = { whatsapp: '#25D366', instagram: '#E1306C', messenger: '#0084FF' };
const CHANNEL_LETTER: Record<string, string> = { whatsapp: 'W', instagram: 'I', messenger: 'M' };

interface Lead {
  id: number;
  name: string;
  number?: string;
  email?: string;
  source?: string;
  channel_type?: string;
  lead_score?: number;
  last_message?: string;
}
interface Stage {
  id: number;
  name: string;
  color: string;
  position: number;
  is_won: boolean;
  leads: Lead[];
  count: number;
}

const Leads = () => {
  const navigate = useNavigate();
  const [stages, setStages] = useState<Stage[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragLead, setDragLead] = useState<{ id: number; from: number } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [menuStage, setMenuStage] = useState<Stage | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editStage, setEditStage] = useState<Stage | null>(null);
  const [formName, setFormName] = useState('');
  const [formColor, setFormColor] = useState(STAGE_COLORS[0]);
  const [saving, setSaving] = useState(false);

  // Lead actions
  const [leadMenuAnchor, setLeadMenuAnchor] = useState<null | HTMLElement>(null);
  const [menuLead, setMenuLead] = useState<Lead | null>(null);
  const [leadDialogOpen, setLeadDialogOpen] = useState(false);
  const [editLead, setEditLead] = useState<Lead | null>(null);
  const [leadName, setLeadName] = useState('');
  const [leadNumber, setLeadNumber] = useState('');
  const [leadEmail, setLeadEmail] = useState('');
  const [savingLead, setSavingLead] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/pipeline/board');
      setStages(data.stages || []);
    } catch {
      toast.error('No se pudo cargar el pipeline');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Drag & drop ──
  const onDrop = async (toStageId: number) => {
    setDragOver(null);
    if (!dragLead || dragLead.from === toStageId) { setDragLead(null); return; }
    const { id, from } = dragLead;
    setDragLead(null);

    // optimistic move
    setStages((prev) => {
      const next = prev.map((s) => ({ ...s, leads: [...s.leads] }));
      const src = next.find((s) => s.id === from);
      const dst = next.find((s) => s.id === toStageId);
      if (!src || !dst) return prev;
      const idx = src.leads.findIndex((l) => l.id === id);
      if (idx === -1) return prev;
      const [lead] = src.leads.splice(idx, 1);
      dst.leads.unshift(lead);
      src.count = src.leads.length; dst.count = dst.leads.length;
      return next;
    });

    try {
      await api.put(`/pipeline/leads/${id}/stage`, { stage_id: toStageId });
    } catch {
      toast.error('No se pudo mover el lead');
      load();
    }
  };

  // ── Stage CRUD ──
  const openCreate = () => { setEditStage(null); setFormName(''); setFormColor(STAGE_COLORS[stages.length % STAGE_COLORS.length]); setDialogOpen(true); };
  const openEdit = (s: Stage) => { setEditStage(s); setFormName(s.name); setFormColor(s.color); setDialogOpen(true); setMenuAnchor(null); };

  const saveStage = async () => {
    if (!formName.trim()) return;
    setSaving(true);
    try {
      if (editStage) await api.put(`/pipeline/stages/${editStage.id}`, { name: formName, color: formColor });
      else await api.post('/pipeline/stages', { name: formName, color: formColor });
      setDialogOpen(false);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al guardar');
    } finally { setSaving(false); }
  };

  const deleteStage = async (s: Stage) => {
    setMenuAnchor(null);
    if (!confirm(`¿Eliminar la etapa "${s.name}"? Los leads pasan a la primera etapa.`)) return;
    try {
      await api.delete(`/pipeline/stages/${s.id}`);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al eliminar');
    }
  };

  const moveStage = async (s: Stage, dir: -1 | 1) => {
    setMenuAnchor(null);
    const ids = stages.map((x) => x.id);
    const i = ids.indexOf(s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setStages((prev) => { const m = new Map(prev.map((x) => [x.id, x])); return ids.map((id) => m.get(id)!); });
    try { await api.put('/pipeline/reorder', { order: ids }); } catch { load(); }
  };

  // ── Lead CRUD ──
  const openEditLead = (l: Lead) => {
    setEditLead(l);
    setLeadName(l.name || '');
    setLeadNumber(l.number || '');
    setLeadEmail(l.email || '');
    setLeadDialogOpen(true);
    setLeadMenuAnchor(null);
  };

  const saveLead = async () => {
    if (!editLead) return;
    setSavingLead(true);
    try {
      await api.put(`/contacts/${editLead.id}`, {
        name: leadName.trim() || undefined,
        number: leadNumber.trim() || undefined,
        email: leadEmail.trim() || undefined,
      });
      toast.success('Lead actualizado');
      setLeadDialogOpen(false);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al actualizar el lead');
    } finally { setSavingLead(false); }
  };

  const deleteLead = async (l: Lead) => {
    setLeadMenuAnchor(null);
    if (!confirm(`¿Eliminar el lead "${l.name}"? Esta acción no se puede deshacer.`)) return;
    try {
      await api.delete(`/contacts/${l.id}`);
      setStages((prev) => prev.map((s) => ({ ...s, leads: s.leads.filter((x) => x.id !== l.id), count: s.leads.filter((x) => x.id !== l.id).length })));
      toast.success('Lead eliminado');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al eliminar el lead');
    }
  };

  if (loading) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: '#E8A020' }} /></Box>;

  const totalLeads = stages.reduce((a, s) => a + s.count, 0);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2' }}>Pipeline de Leads</Typography>
          <Typography sx={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.4)' }}>{totalLeads} leads · {stages.length} etapas · arrastrá las tarjetas entre etapas</Typography>
        </Box>
        <Button variant="outlined" startIcon={<AddIcon />} onClick={openCreate} sx={{ fontSize: '0.8rem', borderColor: 'rgba(232,160,32,0.3)', color: '#E8A020' }}>Nueva etapa</Button>
      </Stack>

      {/* Board */}
      <Box sx={{ display: 'flex', gap: 1.5, overflowX: 'auto', pb: 2, alignItems: 'flex-start' }}>
        {stages.map((s) => (
          <Box
            key={s.id}
            onDragOver={(e) => { e.preventDefault(); setDragOver(s.id); }}
            onDragLeave={() => setDragOver((v) => (v === s.id ? null : v))}
            onDrop={() => onDrop(s.id)}
            sx={{
              minWidth: 270, maxWidth: 270, flexShrink: 0,
              background: dragOver === s.id ? 'rgba(232,160,32,0.06)' : 'rgba(255,255,255,0.015)',
              border: `1px solid ${dragOver === s.id ? 'rgba(232,160,32,0.35)' : 'rgba(255,255,255,0.06)'}`,
              borderRadius: '12px', transition: 'background 150ms ease, border-color 150ms ease',
              maxHeight: 'calc(100vh - 170px)', display: 'flex', flexDirection: 'column',
            }}
          >
            {/* Column header */}
            <Box sx={{ p: 1.5, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <Box sx={{ height: 3, borderRadius: 2, background: s.color, mb: 1 }} />
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Stack direction="row" alignItems="center" spacing={0.8}>
                  <Typography sx={{ fontWeight: 600, fontSize: '0.82rem', color: '#E8EBF2' }}>{s.name}</Typography>
                  <Chip label={s.count} size="small" sx={{ height: 18, fontSize: '0.6rem', backgroundColor: `${s.color}22`, color: s.color }} />
                  {s.is_won && <Typography sx={{ fontSize: '0.6rem', color: '#34D399' }}>✓</Typography>}
                </Stack>
                <IconButton size="small" onClick={(e) => { setMenuAnchor(e.currentTarget); setMenuStage(s); }}>
                  <MoreIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Stack>
            </Box>

            {/* Cards */}
            <Box sx={{ p: 1, overflowY: 'auto', flexGrow: 1, minHeight: 80 }}>
              {s.leads.length === 0 && (
                <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.2)', textAlign: 'center', py: 3 }}>Sin leads</Typography>
              )}
              {s.leads.map((l) => (
                <Box
                  key={l.id}
                  draggable
                  onDragStart={() => setDragLead({ id: l.id, from: s.id })}
                  onDragEnd={() => setDragLead(null)}
                  onClick={() => navigate('/conversations')}
                  sx={{
                    p: 1.2, mb: 1, borderRadius: '9px', cursor: 'grab',
                    background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)',
                    opacity: dragLead?.id === l.id ? 0.4 : 1,
                    transition: 'border-color 150ms ease, transform 150ms ease',
                    '&:hover': { borderColor: `${s.color}44`, transform: 'translateY(-1px)' },
                    '&:active': { cursor: 'grabbing' },
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="flex-start">
                    <Box sx={{ position: 'relative', flexShrink: 0 }}>
                      <Avatar sx={{ width: 30, height: 30, fontSize: '0.75rem', bgcolor: 'rgba(232,160,32,0.14)', color: '#E8A020' }}>
                        {(l.name || '?').slice(0, 1).toUpperCase()}
                      </Avatar>
                      {l.channel_type && CHANNEL_COLOR[l.channel_type] && (
                        <Box sx={{
                          position: 'absolute', bottom: -2, right: -2, width: 13, height: 13, borderRadius: '50%',
                          background: CHANNEL_COLOR[l.channel_type], border: '2px solid #0C0E12',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '0.4rem', color: '#fff',
                        }}>{CHANNEL_LETTER[l.channel_type]}</Box>
                      )}
                    </Box>
                    <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                      <Typography sx={{ fontSize: '0.78rem', fontWeight: 600, color: '#E8EBF2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name}</Typography>
                      {l.last_message && (
                        <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.35)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.last_message}</Typography>
                      )}
                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.4 }}>
                        {l.number && <Typography sx={{ fontSize: '0.62rem', color: 'rgba(255,255,255,0.3)', fontFamily: '"JetBrains Mono", monospace' }}>{l.number}</Typography>}
                        {typeof l.lead_score === 'number' && l.lead_score > 0 && (
                          <Chip label={`${l.lead_score}%`} size="small" sx={{ height: 15, fontSize: '0.55rem', backgroundColor: 'rgba(232,160,32,0.12)', color: '#E8A020' }} />
                        )}
                      </Stack>
                    </Box>
                    <IconButton
                      size="small"
                      onClick={(e) => { e.stopPropagation(); setLeadMenuAnchor(e.currentTarget); setMenuLead(l); }}
                      sx={{ flexShrink: 0, mt: -0.5, mr: -0.5, opacity: 0.5, '&:hover': { opacity: 1 } }}
                    >
                      <MoreIcon sx={{ fontSize: 15 }} />
                    </IconButton>
                  </Stack>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>

      {/* Lead menu */}
      <Menu anchorEl={leadMenuAnchor} open={!!leadMenuAnchor} onClose={() => setLeadMenuAnchor(null)}>
        <MenuItem onClick={() => menuLead && openEditLead(menuLead)}><EditIcon sx={{ fontSize: 16, mr: 1 }} /> Editar lead</MenuItem>
        <MenuItem onClick={() => { setLeadMenuAnchor(null); navigate('/conversations'); }}>Ver conversación</MenuItem>
        <MenuItem onClick={() => menuLead && deleteLead(menuLead)} sx={{ color: '#EF5350' }}><DeleteIcon sx={{ fontSize: 16, mr: 1 }} /> Eliminar lead</MenuItem>
      </Menu>

      {/* Edit lead dialog */}
      <Dialog open={leadDialogOpen} onClose={() => setLeadDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700 }}>Editar lead</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField fullWidth size="small" label="Nombre" value={leadName} onChange={(e) => setLeadName(e.target.value)} />
            <TextField fullWidth size="small" label="Teléfono" value={leadNumber} onChange={(e) => setLeadNumber(e.target.value)} helperText="Número de WhatsApp (con código de país)" />
            <TextField fullWidth size="small" label="Email" type="email" value={leadEmail} onChange={(e) => setLeadEmail(e.target.value)} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLeadDialogOpen(false)}>Cancelar</Button>
          <Button variant="contained" onClick={saveLead} disabled={savingLead}>{savingLead ? <CircularProgress size={18} /> : 'Guardar'}</Button>
        </DialogActions>
      </Dialog>

      {/* Stage menu */}
      <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
        <MenuItem onClick={() => menuStage && openEdit(menuStage)}><EditIcon sx={{ fontSize: 16, mr: 1 }} /> Editar</MenuItem>
        <MenuItem onClick={() => menuStage && moveStage(menuStage, -1)}><ChevronLeft sx={{ fontSize: 16, mr: 1 }} /> Mover ←</MenuItem>
        <MenuItem onClick={() => menuStage && moveStage(menuStage, 1)}><ChevronRight sx={{ fontSize: 16, mr: 1 }} /> Mover →</MenuItem>
        <MenuItem onClick={() => menuStage && deleteStage(menuStage)} sx={{ color: '#EF5350' }}><DeleteIcon sx={{ fontSize: 16, mr: 1 }} /> Eliminar</MenuItem>
      </Menu>

      {/* Create/Edit stage dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700 }}>{editStage ? 'Editar etapa' : 'Nueva etapa'}</DialogTitle>
        <DialogContent>
          <TextField fullWidth size="small" autoFocus label="Nombre de la etapa" value={formName} onChange={(e) => setFormName(e.target.value)} sx={{ mt: 1, mb: 2 }} />
          <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.5)', mb: 1 }}>Color</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
            {STAGE_COLORS.map((c) => (
              <Box key={c} onClick={() => setFormColor(c)} sx={{
                width: 28, height: 28, borderRadius: '8px', background: c, cursor: 'pointer',
                border: formColor === c ? '2px solid #fff' : '2px solid transparent',
                transition: 'transform 120ms ease', '&:hover': { transform: 'scale(1.1)' },
              }} />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancelar</Button>
          <Button variant="contained" onClick={saveStage} disabled={saving || !formName.trim()}>{saving ? <CircularProgress size={18} /> : editStage ? 'Guardar' : 'Crear'}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Leads;
