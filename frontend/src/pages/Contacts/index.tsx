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

type LeadStatus = 'unread' | 'read' | 'waiting';

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
  createdAt: string;
  updatedAt: string;
}

const statusLabel: Record<LeadStatus, string> = {
  unread: 'Nuevo',
  read: 'Leído',
  waiting: 'Esperando'
};

const statusColor: Record<LeadStatus, any> = {
  unread: 'info',
  read: 'default',
  waiting: 'warning'
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
      setLeads(Array.isArray(data) ? data : []);
    } catch {
      toast.error('Error al cargar leads');
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const { data } = await api.get('/users');
      const list = Array.isArray(data) ? data.map((u: any) => ({ id: Number(u.id), name: String(u.name || `Usuario ${u.id}`) })) : [];
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
    const nuevos = leads.filter((l) => (l.leadStatus || 'unread') === 'unread').length;
    const esperando = leads.filter((l) => (l.leadStatus || 'unread') === 'waiting').length;
    const calientes = leads.filter((l) => Number(l.lead_score || 0) >= 70).length;
    return { total, nuevos, esperando, calientes };
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
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Total</Typography><Typography variant='h5'>{stats.total}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Nuevos</Typography><Typography variant='h5'>{stats.nuevos}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Esperando</Typography><Typography variant='h5'>{stats.esperando}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Calientes (score ≥ 70)</Typography><Typography variant='h5'>{stats.calientes}</Typography></Paper></Grid>
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
                <TableCell>Estado</TableCell>
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
                  const st = (l.leadStatus || 'unread') as LeadStatus;
                  const score = Number(l.lead_score || 0);
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
                      <TableCell><Chip size='small' color={statusColor[st]} label={statusLabel[st]} /></TableCell>
                      <TableCell>
                        <Stack direction='row' spacing={0.8} alignItems='center'>
                          <Box sx={{ width: 80 }}><LinearProgress variant='determinate' value={Math.max(0, Math.min(100, score))} sx={{ height: 8, borderRadius: 8 }} /></Box>
                          <Typography variant='caption'>{score}%</Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>{l.source || '-'}</TableCell>
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
