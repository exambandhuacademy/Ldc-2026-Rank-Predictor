const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_PATH = path.join(ROOT, 'data', 'ldc.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');

const getCandidateStmt = db.prepare(`
  SELECT roll_no, application, name, father, mother, gender, category, special, tsp, area
  FROM candidates WHERE roll_no = ?
`);
const upsertSubmissionStmt = db.prepare(`
  INSERT INTO submissions
    (roll_no,p1_right,p1_wrong,p2_right,p2_wrong,p1_score,p2_score,total_score,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(roll_no) DO UPDATE SET
    p1_right=excluded.p1_right, p1_wrong=excluded.p1_wrong,
    p2_right=excluded.p2_right, p2_wrong=excluded.p2_wrong,
    p1_score=excluded.p1_score, p2_score=excluded.p2_score,
    total_score=excluded.total_score, updated_at=excluded.updated_at
`);
const getSubmissionStmt = db.prepare(`SELECT * FROM submissions WHERE roll_no = ?`);

function send(res, status, data, headers={}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers});
  res.end(body);
}
function staticFile(res, filePath) {
  if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res,404,'Not found');
  const ext = path.extname(filePath).toLowerCase();
  const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'}[ext] || 'application/octet-stream';
  res.writeHead(200, {'Content-Type':mime,'Cache-Control':'no-cache'});
  fs.createReadStream(filePath).pipe(res);
}
function jsonBody(req) {
  return new Promise((resolve,reject)=>{
    let body='';
    req.on('data', c=>{ body += c; if (body.length>10000) reject(new Error('Payload too large')); });
    req.on('end', ()=>{ try{ resolve(body ? JSON.parse(body) : {}); }catch(e){ reject(e); } });
    req.on('error',reject);
  });
}
function numInt(v){ const n=Number(v); return Number.isInteger(n) ? n : NaN; }
function scorePaper(right, wrong, valid){
  const MAX=100, TOTAL=150;
  const kf=(MAX/TOTAL)*(TOTAL/valid);
  const rightMarks=right*kf;
  const wrongPenalty=(MAX*wrong)/(TOTAL*3);
  return {kf,rightMarks,wrongPenalty,score:rightMarks-wrongPenalty};
}
function calculateCandidate(p1r,p1w,p2r,p2w){
  if ([p1r,p1w,p2r,p2w].some(Number.isNaN)) throw new Error('Enter integer values only.');
  if (p1r<0||p1w<0||p2r<0||p2w<0) throw new Error('Values cannot be negative.');
  if (p1r+p1w>149) throw new Error('Paper-I: Right + Wrong cannot exceed 149 valid questions.');
  if (p2r+p2w>144) throw new Error('Paper-II: Right + Wrong cannot exceed 144 valid questions.');
  const a=scorePaper(p1r,p1w,149), b=scorePaper(p2r,p2w,144);
  return {...a,p2:b,total:a.score+b.score,p1:a};
}
function rankFor(roll, filters={}){
  const cand=getCandidateStmt.get(roll); if(!cand) return null;
  const sub=getSubmissionStmt.get(roll); if(!sub) return {candidate:cand,submission:null};
  const overall = db.prepare('SELECT COUNT(*) c FROM submissions WHERE total_score > ?').get(sub.total_score).c + 1;
  const catRank = db.prepare(`SELECT COUNT(s.roll_no) c FROM submissions s JOIN candidates c ON c.roll_no=s.roll_no WHERE c.category=? AND s.total_score>?`).get(cand.category,sub.total_score).c + 1;
  const areaRank = db.prepare(`SELECT COUNT(s.roll_no) c FROM submissions s JOIN candidates c ON c.roll_no=s.roll_no WHERE c.area=? AND s.total_score>?`).get(cand.area,sub.total_score).c + 1;
  const submitted = db.prepare('SELECT COUNT(*) c FROM submissions').get().c;
  return {candidate:cand, submission:sub, ranks:{overall,category:catRank,area:areaRank}, submitted};
}
function leaderboard(params){
  const limit=Math.min(Math.max(Number(params.get('limit')||50),1),200);
  const area=params.get('area') || '';
  const category=params.get('category') || '';
  let where=[]; let args=[];
  if(area){where.push('c.area=?');args.push(area);}
  if(category){where.push('c.category=?');args.push(category);}
  const sql=`SELECT s.roll_no,c.name,c.category,c.area,s.total_score,s.p1_score,s.p2_score,s.updated_at
             FROM submissions s JOIN candidates c ON c.roll_no=s.roll_no
             ${where.length?'WHERE '+where.join(' AND '):''}
             ORDER BY s.total_score DESC, s.updated_at ASC LIMIT ?`;
  args.push(limit);
  const rows=db.prepare(sql).all(...args);
  return {rows, count: db.prepare(`SELECT COUNT(*) c FROM submissions s JOIN candidates c ON c.roll_no=s.roll_no ${where.length?'WHERE '+where.join(' AND '):''}`).get(...args.slice(0,-1)).c};
}

const server=http.createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(req.method==='GET' && url.pathname==='/api/stats') {
      const totalCandidates=db.prepare('SELECT COUNT(*) c FROM candidates').get().c;
      const submitted=db.prepare('SELECT COUNT(*) c FROM submissions').get().c;
      const top=db.prepare('SELECT MAX(total_score) m FROM submissions').get().m;
      return send(res,200,{totalCandidates,submitted,topScore:top==null?null:Number(top)});
    }
    if(req.method==='GET' && url.pathname==='/api/candidate') {
      const roll=(url.searchParams.get('roll')||'').replace(/\D/g,'');
      if(!roll) return send(res,400,{error:'Roll number required.'});
      const c=getCandidateStmt.get(roll);
      if(!c) return send(res,404,{error:'Roll number not found in the LDC 2026 typing shortlist.'});
      return send(res,200,{candidate:c});
    }
    if(req.method==='GET' && url.pathname==='/api/rank') {
      const roll=(url.searchParams.get('roll')||'').replace(/\D/g,'');
      if(!roll) return send(res,400,{error:'Roll number required.'});
      const result=rankFor(roll);
      if(!result) return send(res,404,{error:'Roll number not found.'});
      return send(res,200,result);
    }
    if(req.method==='GET' && url.pathname==='/api/leaderboard') {
      return send(res,200,leaderboard(url.searchParams));
    }
    if(req.method==='POST' && url.pathname==='/api/score') {
      const body=await jsonBody(req);
      const roll=String(body.roll||'').replace(/\D/g,'');
      if(!roll) return send(res,400,{error:'Roll number required.'});
      const c=getCandidateStmt.get(roll);
      if(!c) return send(res,404,{error:'Roll number is not present in the official typing shortlist.'});
      const p1r=numInt(body.p1Right),p1w=numInt(body.p1Wrong),p2r=numInt(body.p2Right),p2w=numInt(body.p2Wrong);
      const calc=calculateCandidate(p1r,p1w,p2r,p2w);
      const now=new Date().toISOString();
      upsertSubmissionStmt.run(roll,p1r,p1w,p2r,p2w,calc.p1.score,calc.p2.score,calc.total,now);
      return send(res,200,{ok:true,...rankFor(roll)});
    }
    if(req.method==='GET' && (url.pathname==='/' || !url.pathname.startsWith('/api/'))) {
      let rel=url.pathname==='/'?'index.html':url.pathname.replace(/^\//,'');
      if(rel.includes('..')) return send(res,400,'Bad request');
      return staticFile(res,path.join(PUBLIC,rel));
    }
    return send(res,404,{error:'Not found'});
  } catch(e) {
    console.error(e);
    return send(res,500,{error:e.message||'Server error'});
  }
});

server.listen(PORT,()=>console.log(`Exam Bandhu LDC Rank Predictor running on port ${PORT}`));
