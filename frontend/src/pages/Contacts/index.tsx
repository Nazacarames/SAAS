import {
  Typography, Box, Paper, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Button, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField,
  IconButton, Stack, Chip, MenuItem, Grid, LinearProgress
} from '@mui/material';
import { Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon } from '@mui/icons-material';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../../services/api';

type ContactStatus = 'unread' | 'read' | 'waiting' | 'new' | 'engaged' | 'warm' | 'hot' | string;

interface Contact {
  id: number; name: string; number: string; email: string;
  source?: string; leadStatus?: ContactStatus; business_type?: string;
  needs?: string; lead_score?: number; assignedUserId?: number | null;
  assignedUser?: { id: number; name: string } | null;
  tickets?: Array<{ id: number; status?: string; unreadMessages?: number; updatedAt?: string }>;
  tags?: Array<{ id?: number; name?: string; color?: string }>;
  createdAt: string; updatedAt: string;
}

const statusLabel: Record<string, string> = {
  unread: 'Nuevo', read: 'Leido', waiting: 'Esperando', new: 'Nuevo',
  engaged: 'Contactado', warm: 'Calificado', hot: 'Caliente',
  nuevo_ingreso: 'Nuevo ingreso', primer_contacto: 'Primer contacto',
  esperando_respuesta: 'Esperando respuesta', calificacion: 'Calificacion',
  propuesta: 'Propuesta', cierre: 'Cierre', concretado: 'Concretado'
};

const statusColor: Record<string, any> = {
  unread: 'info', read: 'default', waiting: 'warning', new: 'info',
  engaged: 'primary', warm: 'warning', hot: 'error',
  nuevo_ingreso: 'default', primer_contacto: 'primary',
  esperando_respuesta: 'secondary', calificacion: 'info',
  propuesta: 'warning', cierre: 'error', concretado: 'success'
};

const formatSourceLabel = (source?: string) => {
  const raw = String(source || '').trim();
  if (!raw) return '-';
  if (/^meta_form_/i.test(raw)) return raw.replace(/^meta_form_/i, '').replace(/_/g, ' ').trim();
  if (/^formulario\s+\d+$/i.test(raw)) return 'Formulario Meta';
  return raw;
};

const getLatestTicket = (contact: Contact) => {
  const tickets = Array.isArray(contact.tickets) ? contact.tickets : [];
  if (!tickets.length) return null;
  return [...tickets].sort((a, b) => new Date(b?.updatedAt || 0).getTime() - new Date(a?.updatedAt || 0).getTime())[0];
};

const conversationChip = (contact: Contact): { label: string; color: any } => {
  const latest = getLatestTicket(contact);
  if (!latest) return { label: 'Sin conversacion', color: 'default' };
  const unread = Number(latest?.unreadMessages || 0);
  const st = String(latest?.status || '').toLowerCase();
  if (unread > 0) return { label: 'Mensajes (' + unread + ')', color: 'warning' };
  if (st === 'open') return { label: 'Abierta', color: 'success' };
  if (st === 'pending') return { label: 'Pendiente', color: 'info' };
  if (st === 'closed') return { label: 'Cerrada', color: 'default' };
  return { label: 'Con chat', color: 'default' };
};

const pipelinePhase = (contact: Contact): { key: string; label: string; color: any } => {
  const score = Number(contact.lead_score || 0);
  const leadStatus = String(contact.leadStatus || '').toLowerCase();
  const latest = getLatestTicket(contact);
  const ticketStatus = String(latest?.status || '').toLowerCase();
  const unread = Number(latest?.unreadMessages || 0);
  const explicitPhases = new Set(['nuevo_ingreso', 'primer_contacto', 'esperando_respuesta', 'calificacion', 'propuesta', 'cierre', 'concretado']);
  if (explicitPhases.has(leadStatus)) return { key: leadStatus, label: statusLabel[leadStatus] || leadStatus, color: statusColor[leadStatus] || 'default' };
  if (!latest) return { key: 'nuevo_ingreso', label: 'Nuevo ingreso', color: 'default' };
  if (ticketStatus === 'closed' && score >= 80) return { key: 'concretado', label: 'Concretado', color: 'success' };
  if (score >= 75 || leadStatus === 'hot') return { key: 'cierre', label: 'Cierre', color: 'error' };
  if (score >= 55 || leadStatus === 'warm') return { key: 'propuesta', label: 'Propuesta', color: 'warning' };
  if (score >= 30 || leadStatus === 'engaged') return { key: 'calificacion', label: 'Calificacion', color: 'info' };
  if (unread > 0 || ticketStatus === 'pending') return { key: 'esperando_respuesta', label: 'Esperando', color: 'secondary' };
  return { key: 'primer_contacto', label: 'Primer contacto', color: 'primary' };
};

type UserOpt = { id: number; name: string };

const Contacts = () => {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<ContactStatus | 'all'>('all');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [email, setEmail] = useState('');
  const [source, setSource] = useState('');
  const [leadStatus, setLeadStatus] = useState<ContactStatus>('unread');
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [assignedUserId, setAssignedUserId] = useState<number | ''>('');

  const fetchContacts = async () => {
    setLoading(true);
    try {
      const params = filterStatus !== 'all' ? { status: filterStatus } : {};
      const { data } = await api.get('/contacts', { params });
      const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      setContacts(arr);
    } catch { toast.error('Error al cargar contactos'); }
    finally { setLoading(false); }
  };

  const fetchUsers = async () => {
    try {
      const { data } = await api.get('/users');
      const raw = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      setUsers(raw.map((u: any) => ({ id: Number(u.id), name: String(u.name || 'Usuario ' + u.id) })));
    } catch { setUsers([]); }
  };

  useEffect(() => { fetchContacts(); fetchUsers(); }, [filterStatus]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c => [c.name||'',c.number||'',c.email||'',c.source||''].join(' ').toLowerCase().includes(q));
  }, [contacts, search]);

  const stats = useMemo(() => {
    const byPhase = contacts.reduce((a, c) => { const p = pipelinePhase(c).key; a[p] = (a[p]||0)+1; return a; }, {} as Record<string,number>);
    return {
      total: contacts.length,
      nuevo: byPhase.nuevo_ingreso || 0,
      proceso: (byPhase.primer_contacto||0) + (byPhase.calificacion||0) + (byPhase.propuesta||0) + (byPhase.esperando_respuesta||0),
      cierre: (byPhase.cierre||0) + (byPhase.concretado||0)
    };
  }, [contacts]);

  const resetForm = () => { setName(''); setNumber(''); setEmail(''); setSource(''); setLeadStatus('unread'); setAssignedUserId(''); setEditing(null); };
  const openCreate = () => { resetForm(); setOpen(true); };
  const openEdit = (c: Contact) => {
    setEditing(c); setName(c.name||''); setNumber(c.number||''); setEmail(c.email||'');
    setSource(c.source||''); setLeadStatus((c.leadStatus as ContactStatus)||'unread');
    setAssignedUserId(c.assignedUserId ?? ''); setOpen(true);
  };

  const saveContact = async () => {
    if (!name.trim() || !number.trim()) { toast.error('Nombre y numero obligatorios'); return; }
    setSaving(true);
    try {
      const payload = { name: name.trim(), number: number.trim(), email: email.trim(), source: source.trim()||null, leadStatus, assignedUserId: assignedUserId==='' ? null : Number(assignedUserId) };
      if (editing) { await api.put('/contacts/' + editing.id, payload); toast.success('Contacto actualizado'); }
      else { await api.post('/contacts', payload); toast.success('Contacto creado'); }
      setOpen(false); fetchContacts();
    } catch (e: any) { toast.error(e?.response?.data?.error || 'No se pudo guardar'); }
    finally { setSaving(false); }
  };

  const removeContact = async (c: Contact) => {
    if (!window.confirm('Eliminar ' + c.name + '?')) return;
    try { await api.delete('/contacts/' + c.id); toast.success('Eliminado'); fetchContacts(); }
    catch { toast.error('No se pudo eliminar'); }
  };

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ xs: 'flex-start', md: 'center' }} sx={{ mb: 2, gap: 1 }}>
        <Box><Typography variant='h4'>Contactos</Typography><Typography variant='body2' color='text.secondary'>Gestion de contactos y leads.</Typography></Box>
        <Button variant='contained' startIcon={<AddIcon />} onClick={openCreate}>Nuevo contacto</Button>
      </Stack>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Total</Typography><Typography variant='h5'>{stats.total}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Nuevo</Typography><Typography variant='h5'>{stats.nuevo}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>En proceso</Typography><Typography variant='h5'>{stats.proceso}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Cierre</Typography><Typography variant='h5'>{stats.cierre}</Typography></Paper></Grid>
      </Grid>
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2}>
          <TextField fullWidth label='Buscar' value={search} onChange={e => setSearch(e.target.value)} />
          <TextField select label='Estado' value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)} sx={{ minWidth: 150 }}>
            <MenuItem value='all'>Todos</MenuItem><MenuItem value='unread'>Nuevo</MenuItem><MenuItem value='waiting'>Esperando</MenuItem><MenuItem value='read'>Leido</MenuItem>
          </TextField>
        </Stack>
      </Paper>
      <Paper>{loading && <LinearProgress />}
        <TableContainer>
          <Table>
            <TableHead><TableRow><TableCell>Nombre</TableCell><TableCell>Contacto</TableCell><TableCell>Fase</TableCell><TableCell>Score</TableCell><TableCell>Fuente</TableCell><TableCell>Asignado</TableCell><TableCell>Fecha</TableCell><TableCell align='right'>Acciones</TableCell></TableRow></TableHead>
            <TableBody>
              {!loading && filtered.length === 0 ? (<TableRow><TableCell colSpan={8} align='center'>Sin contactos</TableCell></TableRow>) :
               filtered.map(c => {
                 const score = Number(c.lead_score || 0);
                 const phase = pipelinePhase(c);
                 const conv = conversationChip(c);
                 return (
                   <TableRow key={c.id} hover>
                     <TableCell><Typography variant='body2' sx={{ fontWeight: 700 }}>{c.name}</Typography><Typography variant='caption' color='text.secondary'>{c.business_type || '-'}</Typography></TableCell>
                     <TableCell><Typography variant='body2'>{c.number}</Typography><Typography variant='caption' color='text.secondary'>{c.email || '-'}</Typography></TableCell>
                     <TableCell><Stack direction='row' spacing={0.5}><Chip size='small' color={phase.color} label={phase.label} /><Chip size='small' variant='outlined' color={conv.color} label={conv.label} /></Stack></TableCell>
                     <TableCell><Stack direction='row' spacing={0.5} alignItems='center'><Box sx={{ width: 60 }}><LinearProgress variant='determinate' value={Math.max(0,Math.min(100,score))} sx={{ height: 6, borderRadius: 4 }} /></Box><Typography variant='caption'>{score}%</Typography></Stack></TableCell>
                     <TableCell>{formatSourceLabel(c.source)}</TableCell>
                     <TableCell>{c.assignedUser?.name || 'Sin asignar'}</TableCell>
                     <TableCell><Typography variant='caption'>{new Date(c.updatedAt).toLocaleDateString()}</Typography></TableCell>
                     <TableCell align='right'><IconButton size='small' onClick={() => openEdit(c)}><EditIcon fontSize='small' /></IconButton><IconButton size='small' color='error' onClick={() => removeContact(c)}><DeleteIcon fontSize='small' /></IconButton></TableCell>
                   </TableRow>
                 );
               })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth='sm' fullWidth>
        <DialogTitle>{editing ? 'Editar' : 'Nuevo'} contacto</DialogTitle>
        <DialogContent><Stack spacing={1.5} sx={{ mt: 1 }}>
          <TextField label='Nombre' value={name} onChange={e => setName(e.target.value)} />
          <TextField label='Numero' value={number} onChange={e => setNumber(e.target.value)} />
          <TextField label='Email' value={email} onChange={e => setEmail(e.target.value)} />
          <TextField label='Fuente' value={source} onChange={e => setSource(e.target.value)} />
          <TextField select label='Asignado' value={assignedUserId} onChange={e => setAssignedUserId(e.target.value as any)}>
            <MenuItem value=''>Auto</MenuItem>{users.map(u => (<MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>))}
          </TextField>
          <TextField select label='Estado' value={leadStatus} onChange={e => setLeadStatus(e.target.value as ContactStatus)}>
            <MenuItem value='unread'>Nuevo</MenuItem><MenuItem value='waiting'>Esperando</MenuItem><MenuItem value='read'>Leido</MenuItem>
          </TextField>
        </Stack></DialogContent>
        <DialogActions><Button onClick={() => setOpen(false)}>Cancelar</Button><Button variant='contained' onClick={saveContact} disabled={saving}>{saving ? 'Guardando...' : 'Guardar'}</Button></DialogActions>
      </Dialog>
    </Box>
  );
};

export default Contacts;
