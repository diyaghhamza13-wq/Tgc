import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { ApiError, supabase } from './supabase';

export type PickedFile = { name: string; size: number; mimeType: string; uri: string; webFile?: Blob };

export const MAX_FILE_BYTES = 500 * 1024 * 1024;

/**
 * Production-only uploads: 3D files used to design and manufacture the
 * restoration. Patient photos, CBCT/DICOM images and scanned prescriptions
 * (images / PDF) are not accepted. The database enforces the same rules.
 */
export const ALLOWED_EXTENSIONS = ['stl', 'ply', 'obj', '3mf', 'dcm'] as const;
export type UploadCategory = 'scan' | 'cad_design' | 'production' | 'qc' | 'other';

const EXT_MIME: Record<string, string> = {
  stl: 'model/stl', ply: 'application/octet-stream', obj: 'model/obj', '3mf': 'model/3mf',
  // 3Shape mesh files use .dcm but are not DICOM images (checked below)
  dcm: 'application/octet-stream',
};

export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function isAllowedFileName(name: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** True when the bytes are a DICOM file (the "DICM" marker at offset 128). */
export function isDicomHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

// Words that may stay in a stored file name; anything else (e.g. a patient's
// name or a birth date) is dropped. Keep in sync with
// public._production_file_name() in the database.
const NAME_WORDS = new Set([
  'upper', 'lower', 'maxilla', 'maxillary', 'mandible', 'mandibular', 'antagonist',
  'bite', 'bitescan', 'occlusion', 'occlusal', 'preparation', 'prep', 'prepared',
  'abutment', 'crown', 'crowns', 'bridge', 'coping', 'framework', 'veneer', 'inlay',
  'onlay', 'implant', 'scanbody', 'model', 'die', 'dies', 'gingiva', 'gum',
  'sectioned', 'unsectioned', 'margin', 'design', 'cad', 'cam', 'final', 'milled',
  'mill', 'print', 'printed', 'splint', 'nightguard', 'guard', 'denture', 'base',
  'teeth', 'tooth', 'wax', 'waxup', 'raw', 'original', 'emergence', 'profile',
  'situ', 'situation', 'pre', 'post', 'left', 'right', 'anterior', 'posterior',
  'full', 'arch', 'quadrant', 'scan', 'production', 'qc', 'ur', 'ul', 'lr', 'll',
]);

/** "Dupont_Marie_UpperJaw 16.stl" -> "scan_16.stl"; "lower_prep_v2.stl" -> "scan_lower_prep_v2.stl" */
export function productionFileName(name: string, category: UploadCategory): string {
  const ext = fileExtension(name);
  const tokens: string[] = [];
  // idempotent: an already-cleaned name ("scan_lower.stl") keeps its words once
  const base = name.replace(/\.[A-Za-z0-9]+$/, '').toLowerCase();
  const stem = base === category ? '' : base.startsWith(`${category}_`) ? base.slice(category.length + 1) : base;
  for (const t of stem.split(/[^a-z0-9]+/)) {
    const keep = NAME_WORDS.has(t) || /^[0-9]{1,2}$/.test(t) || /^v[0-9]{1,2}$/.test(t) || /^q[1-4]$/.test(t);
    if (t && keep && !tokens.includes(t) && tokens.length < 8) tokens.push(t);
  }
  return `${category}${tokens.length ? '_' + tokens.join('_') : ''}.${ext}`;
}

/**
 * Name shown in the app. Files uploaded before production-only mode may have
 * an original name that identifies a patient: show a technical label instead
 * (the stored row is not changed).
 */
export function displayFileName(a: { file_name: string; category: string }): string {
  const ext = fileExtension(a.file_name);
  if (isAllowedFileName(a.file_name)) return productionFileName(a.file_name, (a.category as UploadCategory) ?? 'other');
  return ext ? `${a.category}.${ext}` : a.category;
}

/** Opens the file picker. Files that are not production 3D files are returned in `rejected`. */
export async function pickFiles(): Promise<{ files: PickedFile[]; rejected: string[] }> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
  if (res.canceled) return { files: [], rejected: [] };
  const files: PickedFile[] = [];
  const rejected: string[] = [];
  for (const a of res.assets) {
    if (!isAllowedFileName(a.name)) {
      rejected.push(a.name);
      continue;
    }
    files.push({ name: a.name, size: a.size ?? 0, mimeType: EXT_MIME[fileExtension(a.name)], uri: a.uri, webFile: a.file });
  }
  return { files, rejected };
}

function safeName(name: string) {
  return name.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';
}

function uuid() {
  // RFC4122 v4 using Math.random is sufficient for object-name uniqueness
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Upload a production file to Storage and register its metadata row.
 * The object is stored as <lab>/<case>/<uuid>.<ext>; the original file name is
 * never sent: only technical words are kept (see productionFileName).
 */
export async function uploadCaseFile(opts: {
  labId: string;
  caseId: string;
  employeeId: string;
  file: PickedFile;
  category: UploadCategory;
  stageId?: string | null;
}) {
  const { labId, caseId, employeeId, file, category } = opts;
  const ext = fileExtension(file.name);
  if (!isAllowedFileName(file.name)) throw new ApiError('file_type_not_allowed');
  if (file.size > MAX_FILE_BYTES) throw new ApiError('file_too_large');
  let body: Blob | ArrayBuffer;
  let head: Uint8Array;
  if (Platform.OS === 'web' && file.webFile) {
    body = file.webFile;
    head = new Uint8Array(await file.webFile.slice(0, 132).arrayBuffer());
  } else {
    body = await new File(file.uri).arrayBuffer();
    head = new Uint8Array(body.slice(0, 132));
  }
  if (isDicomHeader(head)) throw new ApiError('file_type_not_allowed');

  const path = `${labId}/${caseId}/${uuid()}.${ext}`;
  const mime = EXT_MIME[ext];
  const up = await supabase.storage.from('case-files').upload(path, body, { contentType: mime, upsert: false });
  if (up.error) throw up.error;
  const ins = await supabase.from('attachments').insert({
    lab_id: labId,
    case_id: caseId,
    stage_id: opts.stageId ?? null,
    category,
    file_name: productionFileName(file.name, category),
    mime_type: mime,
    size_bytes: file.size,
    storage_path: path,
    uploaded_by: employeeId,
  });
  if (ins.error) {
    // keep storage and metadata consistent
    await supabase.storage.from('case-files').remove([path]);
    throw ins.error;
  }
}

export async function signedUrl(path: string, seconds = 600): Promise<string> {
  const { data, error } = await supabase.storage.from('case-files').createSignedUrl(path, seconds);
  if (error || !data) throw error ?? new ApiError('server_error');
  return data.signedUrl;
}

/** Download (native: to cache then share sheet; web: browser download). */
export async function openCaseFile(path: string, fileName: string) {
  const url = await signedUrl(path);
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const dest = new File(Paths.cache, `${Date.now()}-${safeName(fileName)}`);
  const f = await File.downloadFileAsync(url, dest, { idempotent: true });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(f.uri);
}

export async function deleteCaseFile(path: string) {
  const rm = await supabase.storage.from('case-files').remove([path]);
  if (rm.error) throw rm.error;
  const del = await supabase.from('attachments').delete().eq('storage_path', path).select('id');
  if (del.error) throw del.error;
  if (!del.data?.length) throw new ApiError('permission_denied');
}

/** Upload an image to the public lab-assets bucket, returns its path. */
export async function uploadLabAsset(labId: string, folder: string, uri: string, mime: string, webFile?: Blob) {
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const path = `${labId}/${folder}/${Date.now()}.${ext}`;
  const body = Platform.OS === 'web' && webFile ? webFile : Platform.OS === 'web' ? await (await fetch(uri)).blob() : await new File(uri).arrayBuffer();
  const { error } = await supabase.storage.from('lab-assets').upload(path, body, { contentType: mime, upsert: true });
  if (error) throw error;
  return path;
}
