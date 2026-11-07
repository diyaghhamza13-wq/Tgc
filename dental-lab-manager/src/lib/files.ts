import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { ApiError, supabase } from './supabase';

export type PickedFile = { name: string; size: number; mimeType: string; uri: string; webFile?: Blob };

export const MAX_FILE_BYTES = 500 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  stl: 'model/stl', ply: 'application/ply', obj: 'model/obj', dcm: 'application/dicom', dicom: 'application/dicom',
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', zip: 'application/zip',
};

export function guessCategory(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['stl', 'ply', 'obj'].includes(ext)) return 'scan';
  if (['dcm', 'dicom'].includes(ext)) return 'cbct';
  if (ext === 'pdf') return 'prescription';
  if (['jpg', 'jpeg', 'png', 'heic', 'webp'].includes(ext)) return 'photo';
  return 'other';
}

export async function pickFiles(): Promise<PickedFile[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
  if (res.canceled) return [];
  return res.assets.map((a) => {
    const ext = a.name.split('.').pop()?.toLowerCase() ?? '';
    return {
      name: a.name,
      size: a.size ?? 0,
      mimeType: a.mimeType || EXT_MIME[ext] || 'application/octet-stream',
      uri: a.uri,
      webFile: a.file,
    };
  });
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

/** Upload a picked file to Storage and register its metadata row. */
export async function uploadCaseFile(opts: {
  labId: string;
  caseId: string;
  employeeId: string;
  file: PickedFile;
  category?: string;
  stageId?: string | null;
}) {
  const { labId, caseId, employeeId, file } = opts;
  if (file.size > MAX_FILE_BYTES) throw new ApiError('file_too_large');
  const path = `${labId}/${caseId}/${uuid()}-${safeName(file.name)}`;
  let body: Blob | ArrayBuffer;
  if (Platform.OS === 'web' && file.webFile) body = file.webFile;
  else body = await new File(file.uri).arrayBuffer();

  const up = await supabase.storage.from('case-files').upload(path, body, { contentType: file.mimeType, upsert: false });
  if (up.error) throw up.error;
  const ins = await supabase.from('attachments').insert({
    lab_id: labId,
    case_id: caseId,
    stage_id: opts.stageId ?? null,
    category: opts.category ?? guessCategory(file.name),
    file_name: file.name,
    mime_type: file.mimeType,
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
