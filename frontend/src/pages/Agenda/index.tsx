import { useEffect, useMemo, useState } from 'react';
import {
  Typography,
  Box,
  Paper,
  Stack,
  TextField,
  Button,
  MenuItem,
  Grid,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  Divider
} from '@mui/material';
import { Add as AddIcon, ChevronLeft, ChevronRight } from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const toYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const statusColor = (status: string) => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'success';
  if (s === 'cancelled') return 'error';
  return 'warning';
};

const Agenda = () => {
  const [contacts, setContacts] = useState<any[]>([]);
  const [appointments, setAppointments] = useState<any[]>([]);
  const [view, setView] = useState<'list' | 'week' | 'month'>('month');
  const [statusFilter, setStatusFilter] = useState('all');

  const [openNew, setOpenNew] = useState(false);
  const [contactId, setContactId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [durationMin, setDurationMin] = useState(30);
  const [notes, setNotes] = useState('');
  const [serviceType, setServiceType] = useState('general');
  const [saving, setSaving] = useState(false);

  const [monthCursor, setMonthCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  const monthStart = new Date(monthCursor.getFullYear(), monthCursor.getMonth(), 1);
  const monthEnd = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);

  const load = async () => {
    try {
      const [c, a] = await Promise.all([
        api.get('/contacts'),
        api.get('/ai/appointments', {
          params: {
            from: new Date(monthStart.getFullYear(), monthStart.getMonth(), 1, 0, 0, 0).toISOString(),
            to: new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate(), 23, 59, 59).toISOString()
          }
        })
      ]);
      setContacts(Array.isArray(c.data) ? c.data : []);
      setAppointments(Array.isArray(a.data) ? a.data : []);
    } catch {
      toast.error('No se pudo cargar agenda');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthCursor]);

  const filteredAppointments = useMemo(() => {
    if (statusFilter === 'all') return appointments;
    return appointments.filter((a: any) => String(a.status || '').toLowerCase() === statusFilter);
  }, [appointments, statusFilter]);

  const stats = useMemo(() => {
    const now = new Date();
    const today = toYmd(now);
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() + 7);

    const isToday = (d: string) => toYmd(new Date(d)) === today;
    const isWeek = (d: string) => {
      const x = new Date(d).getTime();
      return x >= now.getTime() && x <= weekEnd.getTime();
    };

    return {
      today: filteredAppointments.filter((a: any) => isToday(a.starts_at)).length,
      week: filteredAppointments.filter((a: any) => isWeek(a.starts_at)).length,
      pending: filteredAppointments.filter((a: any) => (a.status || '').toLowerCase() === 'scheduled').length,
      done: filteredAppointments.filter((a: any) => (a.status || '').toLowerCase() === 'completed').length
    };
  }, [filteredAppointments]);

  const calendarCells = useMemo(() => {
    const firstDay = new Date(monthStart);
    const offset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = monthEnd.getDate();

    const cells: Array<{ day: number | null; date?: Date }> = [];
    for (let i = 0; i < offset; i++) cells.push({ day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, date: new Date(monthStart.getFullYear(), monthStart.getMonth(), d) });
    }
    while (cells.length % 7 !== 0) cells.push({ day: null });
    return cells;
  }, [monthStart, monthEnd]);

  const apptsByDay = useMemo(() => {
    const map = new Map<string, any[]>();
    filteredAppointments.forEach((a: any) => {
      const key = toYmd(new Date(a.starts_at));
      const list = map.get(key) || [];
      list.push(a);
      map.set(key, list);
    });
    return map;
  }, [filteredAppointments]);

  const createAppointment = async () => {
    if (!contactId || !startsAt) {
      toast.error('Elegí contacto y fecha/hora');
      return;
    }

    setSaving(true);
    try {
      await api.post('/ai/tools/execute', {
        tool: 'agendar_cita',
        args: {
          contactId: Number(contactId),
          startsAt: new Date(startsAt).toISOString(),
          durationMin,
          notes,
          serviceType
        }
      });
      toast.success('Cita creada');
      setOpenNew(false);
      setNotes('');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'No se pudo crear la cita');
    } finally {
      setSaving(false);
    }
  };

  const monthLabel = monthCursor.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ xs: 'flex-start', md: 'center' }} sx={{ mb: 2, gap: 1.2 }}>
        <Box>
          <Typography variant='h4'>Agenda de citas</Typography>
          <Typography variant='body2' color='text.secondary'>Planificá, visualizá y gestioná citas con una vista clara y profesional.</Typography>
        </Box>
        <Button variant='contained' startIcon={<AddIcon />} onClick={() => setOpenNew(true)}>
          Nueva cita
        </Button>
      </Stack>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Hoy</Typography><Typography variant='h5'>{stats.today}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Esta semana</Typography><Typography variant='h5'>{stats.week}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Pendientes</Typography><Typography variant='h5'>{stats.pending}</Typography></Paper></Grid>
        <Grid item xs={12} sm={6} lg={3}><Paper sx={{ p: 2 }}><Typography variant='caption' color='text.secondary'>Completadas</Typography><Typography variant='h5'>{stats.done}</Typography></Paper></Grid>
      </Grid>

      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ xs: 'stretch', md: 'center' }} sx={{ mb: 2, gap: 1 }}>
          <ToggleButtonGroup size='small' value={view} exclusive onChange={(_, v) => v && setView(v)}>
            <ToggleButton value='list'>Lista</ToggleButton>
            <ToggleButton value='week'>Semana</ToggleButton>
            <ToggleButton value='month'>Mes</ToggleButton>
          </ToggleButtonGroup>

          <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap'>
            <Button size='small' onClick={() => setMonthCursor(new Date())}>Hoy</Button>
            <Button size='small' onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}><ChevronLeft /></Button>
            <Typography sx={{ textTransform: 'capitalize', minWidth: 150, textAlign: 'center', fontWeight: 600 }}>{monthLabel}</Typography>
            <Button size='small' onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}><ChevronRight /></Button>
            <TextField select size='small' value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} sx={{ minWidth: 160 }}>
              <MenuItem value='all'>Todos</MenuItem>
              <MenuItem value='scheduled'>Pendientes</MenuItem>
              <MenuItem value='completed'>Completadas</MenuItem>
              <MenuItem value='cancelled'>Canceladas</MenuItem>
            </TextField>
          </Stack>
        </Stack>

        <Divider sx={{ mb: 2 }} />

        {view === 'list' ? (
          <Stack spacing={1}>
            {filteredAppointments.length === 0 ? (
              <Typography variant='body2' color='text.secondary'>No hay citas para este filtro.</Typography>
            ) : filteredAppointments.map((a: any) => (
              <Paper key={a.id} variant='outlined' sx={{ p: 1.2, borderColor: 'divider' }}>
                <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' gap={1}>
                  <Box>
                    <Typography variant='body2' sx={{ fontWeight: 700 }}>{a.contact_name || a.contact_id}</Typography>
                    <Typography variant='caption' color='text.secondary'>
                      {new Date(a.starts_at).toLocaleString()} · {a.service_type || 'general'}
                    </Typography>
                  </Box>
                  <Chip size='small' label={String(a.status || 'scheduled')} color={statusColor(a.status) as any} />
                </Stack>
              </Paper>
            ))}
          </Stack>
        ) : (
          <Box>
            <Grid container columns={7} sx={{ border: '1px solid', borderColor: 'divider', borderBottom: 'none', borderRadius: '10px 10px 0 0', overflow: 'hidden' }}>
              {['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'].map((d) => (
                <Grid item xs={1} key={d} sx={{ p: 1, textAlign: 'center', borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'rgba(255,255,255,0.03)' }}>
                  <Typography variant='caption' color='text.secondary'>{d}</Typography>
                </Grid>
              ))}
            </Grid>

            <Grid container columns={7} sx={{ borderLeft: '1px solid', borderTop: '1px solid', borderColor: 'divider' }}>
              {calendarCells.map((cell, idx) => {
                const key = cell.date ? toYmd(cell.date) : `empty-${idx}`;
                const list = cell.date ? apptsByDay.get(toYmd(cell.date)) || [] : [];
                const isToday = cell.date ? toYmd(cell.date) === toYmd(new Date()) : false;
                return (
                  <Grid item xs={1} key={key} sx={{ minHeight: 124, borderRight: '1px solid', borderBottom: '1px solid', borderColor: 'divider', p: 0.9, bgcolor: isToday ? 'rgba(91,178,255,0.10)' : 'transparent' }}>
                    <Typography variant='caption' sx={{ fontWeight: 700, opacity: cell.day ? 1 : 0.2 }}>{cell.day || ''}</Typography>
                    <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                      {list.slice(0, 2).map((a: any) => (
                        <Chip
                          key={a.id}
                          size='small'
                          color={statusColor(a.status) as any}
                          variant='outlined'
                          label={`${new Date(a.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${a.contact_name || 'Cita'}`}
                        />
                      ))}
                      {list.length > 2 && <Typography variant='caption' color='text.secondary'>+{list.length - 2} más</Typography>}
                    </Stack>
                  </Grid>
                );
              })}
            </Grid>
          </Box>
        )}
      </Paper>

      <Dialog open={openNew} onClose={() => setOpenNew(false)} maxWidth='sm' fullWidth>
        <DialogTitle>Nueva cita</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField select label='Contacto' value={contactId} onChange={(e) => setContactId(e.target.value)}>
              {contacts.map((c: any) => (
                <MenuItem key={c.id} value={String(c.id)}>{c.name} ({c.number})</MenuItem>
              ))}
            </TextField>
            <TextField label='Fecha y hora' type='datetime-local' InputLabelProps={{ shrink: true }} value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            <TextField label='Duración (min)' type='number' value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value || 30))} />
            <TextField label='Servicio' value={serviceType} onChange={(e) => setServiceType(e.target.value)} />
            <TextField label='Notas' value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={3} />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenNew(false)}>Cancelar</Button>
          <Button variant='contained' onClick={createAppointment} disabled={saving}>{saving ? 'Guardando...' : 'Crear cita'}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Agenda;
