import { Pool } from 'pg';
import { NextResponse } from 'next/server';

// Inisialisasi Pool di luar fungsi handler agar koneksi dapat digunakan ulang (reused)
// antar request di environment serverless.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Wajib untuk koneksi ke eksternal seperti Supabase
  },
});

export async function POST(req: Request) {
  try {
    // 1. Tangkap parameter dari Frontend
    const { 
      sessionId, 
      heartRate, 
      asymmetryIndex, 
      au12, 
      au6_7, 
      au4, 
      aiStatus, 
      aiNotes 
    } = await req.json();

    // 2. Siapkan Query SQL menggunakan Parameterized Query ($1, $2, dst)
    // Ini SANGAT PENTING untuk mencegah SQL Injection karena kita tidak lagi
    // menggunakan query builder dari Supabase.
    const query = `
      INSERT INTO public.face_scan_metrics (
        session_id, 
        heart_rate_bpm, 
        asymmetry_index, 
        au12_mouth, 
        au6_7_eye, 
        au4_eyebrow, 
        scan_status, 
        scan_notes
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *;
    `;

    // 3. Masukkan urutan variabel (harus pas dengan angka $1, $2 di atas)
    const values = [
      sessionId,
      heartRate,
      asymmetryIndex,
      au12,
      au6_7,
      au4,
      aiStatus,
      aiNotes
    ];

    // 4. Eksekusi ke database
    const result = await pool.query(query, values);

    return NextResponse.json({ 
      success: true, 
      message: "Metrik berhasil disimpan via koneksi langsung PostgreSQL.",
      data: result.rows[0] // Mengembalikan baris yang baru saja di-insert
    });

  } catch (error: any) {
    console.error("Database Error:", error.message);
    return NextResponse.json(
      { success: false, error: 'Gagal menyimpan metrik ke database.' }, 
      { status: 500 }
    );
  }
}