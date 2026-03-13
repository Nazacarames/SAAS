import {
  Typography,
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  IconButton,
  Stack,
  Chip,
  MenuItem,
  Grid,
  LinearProgress
} from '@mui/material';
import { Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../../services/api';

type LeadStatus = 'unread' | 'read' | 'waiting' | 'new' | 'engaged' | 'warm' | 'hot' | string;

interface Lead {
  id: number;
  name: string;
  number: string;
  email: string;
  source?: string;
  leadStatus?: LeadStatus;
  business_type?: string;
  needs?: string;
  lead_score?: number;
  assignedUserId?: number | null;
  assignedUser?: { id: number; name: string } | null;
  tickets?: Array<{ id: number; status?: string; unreadMessages?: number; updatedAt?: string }>;
  tags?: Array<{ id?: number; name?: string; color?: string }>;
  createdAt: string;
  updatedAt: string;
}

const statusLabel: Record<string, string> = {
  unread: 'Nuevo',
  read: 'Leído',
  waiting: 'Esperando',
  new: 'Nuevo',
  engaged: 'Contactado',
  warm: 'Calificado',
  hot: 'Caliente',
  nuevo_ingreso: 'Nuevo ingreso',
  primer_contacto: 'Primer contacto',
  esperando_respuesta: 'Esperando respuesta',
  calificacion: 'Calificación',
  propuesta: 'Propuesta',
  cierre: 'Cierre',
  concretado: 'Concretado'
};

const statusColor: Record<string, any> = {
  unread: 'info',
  read: 'default',
  waiting: 'warning',
  new: 'info',
  engaged: 'primary',
  warm: 'warning',
  hot: 'error',
  nuevo_ingreso: 'default',
  primer_contacto: 'primary',
  esperando_respuesta: 'secondary',
  calificacion: 'info',
  propuesta: 'warning',
  cierre: 'error',
  concretado: 'success'
};

const formatSourceLabel = (source?: string) => {
  const raw = String(source || '').trim();
  if (!raw) return '-';
  if (/^meta_form_/i.test(raw)) return raw.replace(/^meta_form_/i, '').replace(/_/g, ' ').trim();
  if (/^formulario\s+\d+$/i.test(raw)) return 'Formulario Meta (nombre no disponible)';
  return raw;
};

const getLatestTicket = (lead: Lead) => {
  const tickets = Array.isArray(lead.tickets) ? lead.tickets : [];
  if (!tickets.length) return null;
  return [...tickets].sort((a, b) => {
    const ta = new Date(a?.updatedAt || 0).getTime();
    const tb = new Date(b?.updatedAt || 0).getTime();
    return tb - ta;
  })[0];
};

const conversationChipFromLead = (lead: Lead): { label: string; color: any } => {
  const latest = getLatestTicket(lead);
  if (!latest) return { label: 'Sin conversación', color: 'default' };

  const unread = Number(latest?.unreadMessages || 0);
  const st = String(latest?.status || '').toLowerCase();
  if (unread > 0) return { label: `Con mensajes (${unread})`, color: 'warning' };
  if (st === 'open') return { label: 'Conversación abierta', color: 'success' };
  if (st === 'pending') return { label: 'Conversación pendiente', color: 'info' };
  if (st === 'closed') return { label: 'Conversación cerrada', color: 'default' };
  return { label: 'Con conversación', color: 'default' };
};

const pipelinePhaseFromLead = (lead: Lead): { key: string; label: string; color: any } => {
  const score = Number(lead.lead_score || 0);
  const leadStatus = String(lead.leadStatus || '').toLowerCase();
  const latest = getLatestTicket(lead);
  const ticketStatus = String(latest?.status || '').toLowerCase();
  const unread = Number(latest?.unreadMessages || 0);

  const explicitBotPhase = new Set(['nuevo_ingreso', 'primer_contacto', 'esperando_respuesta', 'calificacion', 'propuesta', 'cierre', 'concretado']);
  if (explicitBotPhase.has(leadStatus)) {
    return { key: leadStatus, label: statusLabel[leadStatus] || leadStatus, color: statusColor[leadStatus] || 'default' };
  }

  if (!latest) return { key: 'nuevo_ingreso', label: 'Nuevo ingreso', color: 'default' };
  if (ticketStatus === 'closed' && score >= 80) return { key: 'concretado', label: 'Concretado', color: 'success' };
  if (score >= 75 || leadStatus === 'hot') return { key: 'cierre', label: 'Cierre', color: 'error' };
  if (score >= 55 || leadStatus === 'warm') return { key: 'propuesta', label: 'Propuesta', color: 'warning' };
  if (score >= 30 || leadStatus === 'engaged') return { key: 'calificacion', label: 'Calificación', color: 'info' };
  if (unread > 0 || ticketStatus === 'pending') return { key: 'esperando_respuesta', label: 'Esperando respuesta', color: 'secondary' };
  return { key: 'primer_contacto', label: 'Primer contacto', color: 'primary' };
};

type UserOption = { id: number; name: string };

const Leads = () => {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<LeadStatus | 'all'>('all');

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);

  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [email, setEmail] = useState('');
  const [source, setSource] = useState('');
  const [leadStatus, setLeadStatus] = useState<LeadStatus>('unread');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [assignedUserId, setAssignedUserId] = useState<number | ''>('');

  const fetchLeads = async () => {
    setLoading(true);
    try {
      const params: any = {};
      if (filterStatus !== 'all') params.status = filterStatus;
      const { data } = await api.get('/contacts', { params });
      const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      setLeads(arr);
    } catch {
      toast.error('Error al cargar leads');
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const { data } = await api.get('/users');
      const raw = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      const list = raw.map((u: any) => ({ id: Number(u.id), name: String(u.name || `Usuario ${u.id}`) }));
      setUsers(list);
    } catch {
      setUsers([]);
    }
  };

  useEffect(() => {
    fetchLeads();
    fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) => [l.name || '', l.number || '', l.email || '', l.source || ''].join(' ').toLowerCase().includes(q));
  }, [leads, search]);

  const stats = useMemo(() => {
    const total = leads.length;
    const byPhase = leads.reduce((acc: Record<string, number>, lead) => {
      const phase = pipelinePhaseFromLead(lead).key;
      acc[phase] = (acc[phase] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return {
      total,
      nuevoIngreso: byPhase.nuevo_ingreso || 0,
      procesoVenta: (byPhase.primer_contacto || 0) + (byPhase.calificacion || 0) + (byPhase.propuesta || 0) + (byPhase.esperando_respuesta || 0),
      cierre: byPhase.cierre || 0,
      concretado: byPhase.concretado || 0
    };
  }, [leads]);

  const resetForm = () => {
    setName('');
    setNumber('');
    setEmail('');
    setSource('');
    setLeadStatus('unread');
    setAssignedUserId('');
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setOpen(true);
  };

  const openEdit = (lead: Lead) => {
    setEditing(lead);
    setName(lead.name || '');
    setNumber(lead.number || '');
    setEmail(lead.email || '');
    setSource(lead.source || '');
    setLeadStatus((lead.leadStatus as LeadStatus) || 'unread');
    setAssignedUserId(lead.assignedUserId ?? '');
    setOpen(true);
  };

  const saveLead = async () => {
    if (!name.trim() || !number.trim()) {
      toast.error('Nombre y número son obligatorios');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        number: number.trim(),
        email: email.trim(),
        source: source.trim() || null,
        leadStatus,
        assignedUserId: assignedUserId === '' ? null : Number(assignedUserId)
      };
      if (editing) {
        await api.put(`/contacts/${editing.id}`, payload);
        toast.success('Lead actualizado');
      } else {
        await api.post('/contacts', payload);
        toast.success('Lead creado');
      }
      setOpen(false);
      fetchLeads();
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  };

  const removeLead = async (lead: Lead) => {
    if (!window.confirm(`¿Eliminar lead ${lead.name}?`)) return;
    try {
      await api.delete(`/contacts/${lead.id}`);
      toast.success('Lead eliminado');
      fetchLeads();
    } catch {
      toast.error('No se pudo eliminar');
    }
  };

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ xs: 'flex-start', md: 'center' }} sx={{ mb: 2, gap: 1 }}>
        <Box>
          <Typography variant='h4'>Leads</Typography>
          <Typography variant='body2' color='text.secondary'>Pipeline comercial con asignación y scoring.</Typography>
        </Box>
        <Button variant='contained' startIcon={<AddIcon />} onClick={openCreate}>Nuevo lead</Button>
      </Stack>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Total leads</Typography><Typography variant='h5'>{stats.total}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Nuevo ingreso</Typography><Typography variant='h5'>{stats.nuevoIngreso}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>En proceso de venta</Typography><Typography variant='h5'>{stats.procesoVenta}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Cierre / Concretado</Typography><Typography variant='h5'>{stats.cierre + stats.concretado}</Typography></Paper></Grid>
      </Grid>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2}>
          <TextField fullWidth label='Buscar por nombre, número, email o fuente' value={search} onChange={(e) => setSearch(e.target.value)} />
          <TextField select label='Estado' value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as any)} sx={{ minWidth: 180 }}>
            <MenuItem value='all'>Todos</MenuItem>
            <MenuItem value='unread'>Nuevo</MenuItem>
            <MenuItem value='waiting'>Esperando</MenuItem>
            <MenuItem value='read'>Leído</MenuItem>
          </TextField>
        </Stack>
      </Paper>

      <Paper>
        {loading && <LinearProgress />}
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Lead</TableCell>
                <TableCell>Contacto</TableCell>
                <TableCell>Fase comercial</TableCell>
                <TableCell>Score</TableCell>
                <TableCell>Fuente</TableCell>
                <TableCell>Asignado</TableCell>
                <TableCell>Actualizado</TableCell>
                <TableCell align='right'>Acciones</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!loading && filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} align='center'>Sin leads</TableCell></TableRow>
              ) : (
                filtered.map((l) => {
                  const st = String(l.leadStatus || 'unread').toLowerCase();
                  const score = Number(l.lead_score || 0);
                  const tagNames = (Array.isArray(l.tags) ? l.tags : []).map((t: any) => String(t?.name || '').toLowerCase());
                  const sentToTokko = tagNames.includes('enviado_tokko');
                  return (
                    <TableRow key={l.id} hover>
                      <TableCell>
                        <Typography variant='body2' sx={{ fontWeight: 700 }}>{l.name}</Typography>
                        <Typography variant='caption' color='text.secondary'>{l.business_type || '-'}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant='body2'>{l.number}</Typography>
                        <Typography variant='caption' color='text.secondary'>{l.email || '-'}</Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction='row' spacing={0.7} useFlexGap flexWrap='wrap'>
                          {(() => {
                            const phase = pipelinePhaseFromLead(l);
                            const statusText = statusLabel[st] || st || 'Sin estado';
                            const sameAsPhase = String(statusText).trim().toLowerCase() === String(phase.label).trim().toLowerCase();
                            return (
                              <>
                                <Chip size='small' color={phase.color} label={phase.label} />
                                {!sameAsPhase && (
                                  <Chip size='small' variant='outlined' color={statusColor[st] || 'default'} label={statusText} />
                                )}
                              </>
                            );
                          })()}
                          {(() => {
                            const conv = conversationChipFromLead(l);
                            return <Chip size='small' variant='outlined' color={conv.color} label={conv.label} />;
                          })()}
                          {sentToTokko && (
                            <Chip size='small' variant='outlined' color='info' label='Enviado Tokko' />
                          )}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack direction='row' spacing={0.8} alignItems='center'>
                          <Box sx={{ width: 80 }}><LinearProgress variant='determinate' value={Math.max(0, Math.min(100, score))} sx={{ height: 8, borderRadius: 8 }} /></Box>
                          <Typography variant='caption'>{score}%</Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>{formatSourceLabel(l.source)}</TableCell>
                      <TableCell>{l.assignedUser?.name || 'Sin asignar'}</TableCell>
                      <TableCell>{new Date(l.updatedAt).toLocaleString()}</TableCell>
                      <TableCell align='right'>
                        <IconButton size='small' onClick={() => openEdit(l)}><EditIcon fontSize='small' /></IconButton>
                        <IconButton size='small' color='error' onClick={() => removeLead(l)}><DeleteIcon fontSize='small' /></IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth='sm' fullWidth>
        <DialogTitle>{editing ? 'Editar lead' : 'Nuevo lead'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField label='Nombre' value={name} onChange={(e) => setName(e.target.value)} />
            <TextField label='Número' value={number} onChange={(e) => setNumber(e.target.value)} />
            <TextField label='Email' value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextField label='Fuente' value={source} onChange={(e) => setSource(e.target.value)} />
            <TextField select label='Asignado a' value={assignedUserId} onChange={(e) => setAssignedUserId(e.target.value as any)}>
              <MenuItem value=''>Auto (menor carga)</MenuItem>
              {users.map((u) => (<MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>))}
            </TextField>
            <TextField select label='Estado del lead' value={leadStatus} onChange={(e) => setLeadStatus(e.target.value as LeadStatus)}>
              <MenuItem value='unread'>Nuevo</MenuItem>
              <MenuItem value='waiting'>Esperando</MenuItem>
              <MenuItem value='read'>Leído</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancelar</Button>
          <Button variant='contained' onClick={saveLead} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Leads;
