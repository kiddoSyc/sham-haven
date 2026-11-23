import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient, Role, VerificationStatus, ListingStatus, Prisma, AdminLevel, ReportStatus, ReportTargetType, AgentAccountStatus } from '@prisma/client';
import { z } from 'zod';

const app = express();
const prisma = new PrismaClient();
const PORT = Number(process.env.PORT || 4000);
const ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(x=>x.trim()).filter(Boolean);
const ORIGIN = ORIGINS[0] || 'http://localhost:5173';
const API_PUBLIC_ORIGIN = process.env.API_PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || '';
if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads-private');
const propertyImageDir = path.resolve(process.env.PROPERTY_IMAGE_DIR || './uploads-property');
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(propertyImageDir, { recursive: true });
fs.mkdirSync(propertyImageDir, { recursive: true });
const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, propertyImageDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});
// Public listing photos must be loadable by the separate frontend origin.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use('/media/properties', express.static(propertyImageDir, { fallthrough: false, maxAge: '7d', immutable: true }));
app.use(cors({ origin: (origin, callback) => { if (!origin || ORIGINS.includes(origin)) callback(null, true); else callback(new Error('Origin not allowed.')); }, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers.origin && !ORIGINS.includes(req.headers.origin)) return res.status(403).json({ error: 'Request origin not allowed.' });
  next();
});
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));

type AuthRequest = Request & { user?: { id: string; role: Role } };
const asyncRoute = (fn: (req: AuthRequest, res: Response, next: NextFunction) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req as AuthRequest, res, next)).catch(next);
function auth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.pc_session;
  if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
  try {
    const claims = jwt.verify(token, JWT_SECRET) as { id: string };
    prisma.user.findUnique({ where: { id: claims.id }, select: { id: true, role: true, accountStatus: true } }).then((account) => {
      if (!account || account.accountStatus === AgentAccountStatus.SUSPENDED) {
        res.clearCookie('pc_session', { ...cookieOptions, maxAge: undefined });
        return res.status(403).json({ error: 'This account is suspended. Contact Sham Haven support.' });
      }
      req.user = { id: account.id, role: account.role };
      next();
    }).catch(next);
  } catch { res.clearCookie('pc_session'); return res.status(401).json({ error: 'Your session has expired. Please sign in again.' }); }
}
const allow = (...roles: Role[]) => (req: AuthRequest, res: Response, next: NextFunction) => !req.user || !roles.includes(req.user.role) ? res.status(403).json({ error: 'You do not have permission to do that.' }) : next();
const adminRank: Record<AdminLevel, number> = { SUPPORT_ADMIN: 1, ADMIN: 2, SUPER_ADMIN: 3 };
const requireAdminLevel = (minimum: AdminLevel) => asyncRoute(async (req, res, next) => {
  if (req.user?.role !== Role.ADMIN) return res.status(403).json({ error: 'Administrator access required.' });
  const admin = await prisma.user.findUnique({ where: { id: req.user.id }, select: { adminLevel: true } });
  if (!admin || adminRank[admin.adminLevel] < adminRank[minimum]) return res.status(403).json({ error: 'Your administrator level does not allow this action.' });
  next();
});
const cookieOptions = { httpOnly: true, secure: process.env.COOKIE_SECURE === 'true', sameSite: 'lax' as const, path: '/', maxAge: 7 * 24 * 60 * 60 * 1000 };
const safeUser = (u: { id:string; name:string; email:string; phone:string|null; role:Role; adminLevel?:AdminLevel; agentProfile?: any }) => ({
  id:u.id, name:u.name, email:u.email, phone:u.phone, role:u.role, adminLevel:u.adminLevel,
  agentProfile:u.agentProfile ? {
    agencyName:u.agentProfile.agencyName ?? null,
    registrationNumber:u.agentProfile.registrationNumber ?? null,
    verificationStatus:u.agentProfile.verificationStatus,
    reviewNote:u.agentProfile.reviewNote ?? null,
    submittedAt:u.agentProfile.submittedAt ?? null,
    reviewedAt:u.agentProfile.reviewedAt ?? null
  } : null
});

app.get('/api/health', (_req,res) => res.json({ status:'ok', service:'Sham Haven API' }));
app.post('/api/auth/register', asyncRoute(async (req,res) => {
  const schema = z.object({ name:z.string().trim().min(2).max(80), email:z.string().email().max(160), phone:z.string().trim().max(24).optional(), password:z.string().min(10).max(72), accountType:z.enum(['CUSTOMER','AGENT']).default('CUSTOMER') });
  const data = schema.parse(req.body);
  const email = data.email.toLowerCase();
  if (await prisma.user.findUnique({ where:{email} })) return res.status(409).json({ error:'An account with this email already exists.' });
  const passwordHash = await bcrypt.hash(data.password, 12);
  const user = await prisma.user.create({ data:{ name:data.name, email, phone:data.phone, passwordHash, role:data.accountType, ...(data.accountType === 'AGENT' ? { agentProfile:{create:{}} } : {}) }, include:{agentProfile:true} });
  const token = jwt.sign({ id:user.id, role:user.role }, JWT_SECRET, { expiresIn:'7d' });
  res.cookie('pc_session', token, cookieOptions).status(201).json({ user:safeUser(user) });
}));
app.post('/api/auth/login', asyncRoute(async (req,res) => {
  const data = z.object({ email:z.string().email(), password:z.string().min(1).max(72) }).parse(req.body);
  const user = await prisma.user.findUnique({ where:{email:data.email.toLowerCase()}, include:{agentProfile:true} });
  if (!user || !(await bcrypt.compare(data.password,user.passwordHash))) return res.status(401).json({error:'Email or password is incorrect.'});
  if(user.accountStatus===AgentAccountStatus.SUSPENDED)return res.status(403).json({error:'This account is suspended. Contact Sham Haven support.'});
  const token = jwt.sign({id:user.id,role:user.role},JWT_SECRET,{expiresIn:'7d'});
  res.cookie('pc_session',token,cookieOptions).json({user:safeUser(user)});
}));
app.post('/api/auth/logout', (_req,res) => { res.clearCookie('pc_session',{...cookieOptions,maxAge:undefined}); res.json({ok:true}); });
app.get('/api/auth/me',auth,asyncRoute(async(req,res)=>{ const user=await prisma.user.findUnique({where:{id:req.user!.id},include:{agentProfile:true}}); if(!user)return res.status(401).json({error:'Account not found.'}); res.json({user:safeUser(user)}); }));


async function validFileSignature(file: Express.Multer.File): Promise<boolean> {
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const b = head.subarray(0, bytesRead);
    if (file.mimetype === 'application/pdf') return b.subarray(0,5).toString() === '%PDF-';
    if (file.mimetype === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    if (file.mimetype === 'image/png') return b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    if (file.mimetype === 'image/webp') return b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP';
    return false;
  } finally { await handle.close(); }
}

const certStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
});

const certUpload = multer({
  storage: certStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype);
    cb(null, ok);
  }
});

const propertyImageUpload = multer({
  storage: imageStorage,
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(null, ok);
  }
});
app.post('/api/agent/verification',auth,allow(Role.AGENT),certUpload.single('certificate'),asyncRoute(async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Upload your certificate or supporting document.'});
  if(!(await validFileSignature(req.file))){await fs.promises.unlink(req.file.path).catch(()=>{});return res.status(400).json({error:'The uploaded document does not match its file type.'});}
  const data=z.object({agencyName:z.string().trim().max(120).optional(),registrationNumber:z.string().trim().max(100).optional()}).parse(req.body);
  const existing=await prisma.agentProfile.findUnique({where:{userId:req.user!.id}});
  if(existing?.verificationStatus===VerificationStatus.APPROVED)return res.status(409).json({error:'Your agent profile is already approved. Contact support if your details need updating.'});
  if(existing?.certificatePath) { const old=path.resolve(existing.certificatePath); if(old.startsWith(uploadDir+path.sep)) fs.promises.unlink(old).catch(()=>{}); }
  const profile=await prisma.agentProfile.upsert({where:{userId:req.user!.id},update:{agencyName:data.agencyName,registrationNumber:data.registrationNumber,certificatePath:req.file.path,certificateOriginalName:req.file.originalname,verificationStatus:VerificationStatus.PENDING,submittedAt:new Date(),reviewNote:null},create:{userId:req.user!.id,agencyName:data.agencyName,registrationNumber:data.registrationNumber,certificatePath:req.file.path,certificateOriginalName:req.file.originalname,verificationStatus:VerificationStatus.PENDING,submittedAt:new Date()}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'AGENT_VERIFICATION_SUBMITTED',targetType:'AgentProfile',targetId:profile.id}});
  res.status(201).json({status:profile.verificationStatus,message:'Application received. Our team aims to review complete applications within 24 hours. Approval is not automatic.'});
}));
app.get('/api/admin/verifications',auth,allow(Role.ADMIN),asyncRoute(async(_req,res)=>{
  const rows=await prisma.agentProfile.findMany({where:{verificationStatus:{in:[VerificationStatus.PENDING,VerificationStatus.UNDER_REVIEW]}},include:{user:{select:{id:true,name:true,email:true,phone:true}}},orderBy:{submittedAt:'asc'}});
  res.json(rows.map(p=>({id:p.id,agencyName:p.agencyName,registrationNumber:p.registrationNumber,status:p.verificationStatus,submittedAt:p.submittedAt,applicant:p.user,documentAvailable:Boolean(p.certificatePath)})));
}));
app.get('/api/admin/verifications/:id/document',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const profile=await prisma.agentProfile.findUnique({where:{id:req.params.id},select:{certificatePath:true,certificateOriginalName:true}});
  if(!profile?.certificatePath)return res.status(404).json({error:'Verification document not found.'});
  const file=path.resolve(profile.certificatePath);
  if(!file.startsWith(uploadDir+path.sep)||!fs.existsSync(file))return res.status(404).json({error:'Verification document is unavailable.'});
  res.download(file,profile.certificateOriginalName||'agent-certificate');
}));
app.post('/api/admin/verifications/:id/review',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const data=z.object({decision:z.enum(['APPROVED','REJECTED']),note:z.string().trim().min(5).max(500)}).parse(req.body);
  const profile=await prisma.agentProfile.findUnique({where:{id:req.params.id}}); if(!profile)return res.status(404).json({error:'Application not found.'});
  const updated=await prisma.agentProfile.update({where:{id:profile.id},data:{verificationStatus:data.decision,reviewNote:data.note,reviewedAt:new Date(),reviewedById:req.user!.id}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:`AGENT_VERIFICATION_${data.decision}`,targetType:'AgentProfile',targetId:profile.id,metadata:{note:data.note}}});
  res.json({status:updated.verificationStatus,note:updated.reviewNote});
}));

const propertySchema=z.object({title:z.string().trim().min(8).max(120),description:z.string().trim().min(30).max(5000),propertyType:z.enum(['HOUSE','APARTMENT','LAND','COMMERCIAL','OFFICE','SHOP','WAREHOUSE','FARM']),transactionType:z.enum(['SALE','RENT','SHORT_LET']),priceNaira:z.coerce.bigint().positive(),city:z.string().trim().min(2).max(80),state:z.string().trim().min(2).max(80),area:z.string().trim().max(100).optional(),address:z.string().trim().max(180).optional(),bedrooms:z.coerce.number().int().min(0).max(100).optional(),bathrooms:z.coerce.number().int().min(0).max(100).optional(),landSizeSqm:z.coerce.number().positive().optional(),coverImageUrl:z.string().url().optional(),images:z.array(z.string().url()).max(12).default([])});
app.get('/api/properties',asyncRoute(async(req,res)=>{
  const q=z.object({search:z.string().max(100).optional(),city:z.string().max(80).optional(),state:z.string().max(80).optional(),transactionType:z.enum(['SALE','RENT','SHORT_LET']).optional(),propertyType:z.enum(['HOUSE','APARTMENT','LAND','COMMERCIAL','OFFICE','SHOP','WAREHOUSE','FARM']).optional(),minPrice:z.coerce.bigint().nonnegative().optional(),maxPrice:z.coerce.bigint().positive().optional(),bedrooms:z.coerce.number().int().min(0).max(100).optional(),bathrooms:z.coerce.number().int().min(0).max(100).optional(),sort:z.enum(['newest','oldest','price_asc','price_desc']).default('newest'),take:z.coerce.number().int().min(1).max(40).default(12)}).refine(v=>v.minPrice===undefined||v.maxPrice===undefined||v.minPrice<=v.maxPrice,{message:'Minimum price cannot exceed maximum price.'}).parse(req.query);
  const where:Prisma.PropertyWhereInput={status:ListingStatus.PUBLISHED,deletedAt:null,...(q.city?{city:{contains:q.city,mode:'insensitive'}}:{}),...(q.state?{state:{contains:q.state,mode:'insensitive'}}:{}),...(q.transactionType?{transactionType:q.transactionType}:{}),...(q.propertyType?{propertyType:q.propertyType}:{}),...((q.minPrice!==undefined||q.maxPrice!==undefined)?{priceNaira:{...(q.minPrice!==undefined?{gte:q.minPrice}:{}),...(q.maxPrice!==undefined?{lte:q.maxPrice}:{})}}:{}),...(q.bedrooms!==undefined?{bedrooms:{gte:q.bedrooms}}:{}),...(q.bathrooms!==undefined?{bathrooms:{gte:q.bathrooms}}:{}),...(q.search?{OR:[{title:{contains:q.search,mode:'insensitive'}},{description:{contains:q.search,mode:'insensitive'}},{city:{contains:q.search,mode:'insensitive'}},{area:{contains:q.search,mode:'insensitive'}}]}:{})};
  const orderBy:Prisma.PropertyOrderByWithRelationInput[]=[{featured:'desc'},q.sort==='price_asc'?{priceNaira:'asc'}:q.sort==='price_desc'?{priceNaira:'desc'}:q.sort==='oldest'?{createdAt:'asc'}:{createdAt:'desc'}];
  const rows=await prisma.property.findMany({where,include:{owner:{select:{id:true,name:true,agentProfile:{select:{verificationStatus:true,agencyName:true}}}}},orderBy,take:q.take});
  res.json(rows.map(p=>({...p,priceNaira:p.priceNaira.toString()})));
}));
app.get('/api/properties/:id',asyncRoute(async(req,res)=>{const p=await prisma.property.findFirst({where:{id:req.params.id,status:ListingStatus.PUBLISHED,deletedAt:null},include:{owner:{select:{id:true,name:true,phone:true,agentProfile:{select:{verificationStatus:true,agencyName:true}}}}}});if(!p)return res.status(404).json({error:'Property not found.'});res.json({...p,priceNaira:p.priceNaira.toString()});}));
app.post('/api/properties',auth,allow(Role.AGENT),asyncRoute(async(req,res)=>{const profile=await prisma.agentProfile.findUnique({where:{userId:req.user!.id}});if(profile?.verificationStatus!==VerificationStatus.APPROVED)return res.status(403).json({error:'Your agent account must be approved before you can publish listings.'});const activeSubscription=await prisma.subscription.findFirst({where:{userId:req.user!.id,status:'ACTIVE',endsAt:{gt:new Date()}},orderBy:{endsAt:'desc'}});const listingLimit=activeSubscription?(activeSubscription.plan==='STARTER'?5:activeSubscription.plan==='GROWTH'?25:100):1;const currentCount=await prisma.property.count({where:{ownerId:req.user!.id,deletedAt:null,status:{notIn:[ListingStatus.SOLD,ListingStatus.RENTED,ListingStatus.REJECTED,ListingStatus.EXPIRED]}}});if(currentCount>=listingLimit)return res.status(403).json({error:`Your current plan allows ${listingLimit} active listing${listingLimit===1?'':'s'}. Upgrade your plan to add more.`});const data=propertySchema.parse(req.body);const p=await prisma.property.create({data:{...data,ownerId:req.user!.id,status:ListingStatus.PENDING_REVIEW}});await prisma.auditLog.create({data:{actorId:req.user!.id,action:'PROPERTY_CREATED',targetType:'Property',targetId:p.id}});res.status(201).json({...p,priceNaira:p.priceNaira.toString(),message:'Listing submitted for admin review. It will appear publicly after approval.'});}));
app.get('/api/agent/listings',auth,allow(Role.AGENT),asyncRoute(async(req,res)=>{const rows=await prisma.property.findMany({where:{ownerId:req.user!.id},orderBy:{createdAt:'desc'}});res.json(rows.map(p=>({...p,priceNaira:p.priceNaira.toString()})));}));
app.patch('/api/agent/listings/:id/status',auth,allow(Role.AGENT),asyncRoute(async(req,res)=>{const data=z.object({status:z.enum(['PUBLISHED','PAUSED','SOLD','RENTED','PENDING_REVIEW'])}).parse(req.body);const listing=await prisma.property.findFirst({where:{id:req.params.id,ownerId:req.user!.id}});if(!listing)return res.status(404).json({error:'Listing not found.'});if(listing.deletedAt)return res.status(409).json({error:'This property was removed by an administrator. Contact support if you believe this was a mistake.'});const relistRequest=data.status==='PENDING_REVIEW'&&(listing.status===ListingStatus.SOLD||listing.status===ListingStatus.RENTED);const allowed=(listing.status===ListingStatus.PUBLISHED&&(data.status==='PAUSED'||data.status==='SOLD'||data.status==='RENTED'))||(listing.status===ListingStatus.PAUSED&&data.status==='PUBLISHED')||relistRequest;if(!allowed)return res.status(409).json({error:'That listing status change is not allowed.'});if(data.status==='PUBLISHED'||relistRequest){const profile=await prisma.agentProfile.findUnique({where:{userId:req.user!.id}});if(profile?.verificationStatus!==VerificationStatus.APPROVED)return res.status(403).json({error:'Approved agent verification is required to publish or relist a property.'});}const p=await prisma.property.update({where:{id:listing.id},data:{status:relistRequest?ListingStatus.PENDING_REVIEW:data.status}});await prisma.auditLog.create({data:{actorId:req.user!.id,action:relistRequest?'PROPERTY_RELIST_REQUESTED':`PROPERTY_STATUS_${data.status}`,targetType:'Property',targetId:listing.id,metadata:relistRequest?{reason:'Agent requested relisting after a cancelled deal; admin reapproval required.'}:undefined}});res.json({...p,priceNaira:p.priceNaira.toString(),message:relistRequest?'Relisting request sent to admin for approval.':''});}));

// Property images are public listing media; agent certificates remain private.
app.post('/api/agent/listings/:id/images',auth,allow(Role.AGENT),propertyImageUpload.array('images',12),asyncRoute(async(req,res)=>{
  const listing=await prisma.property.findFirst({where:{id:req.params.id,ownerId:req.user!.id}});
  if(!listing)return res.status(404).json({error:'Listing not found.'});
  if(listing.status!==ListingStatus.PENDING_REVIEW && listing.status!==ListingStatus.DRAFT) return res.status(409).json({error:'Photos can only be added before a listing is approved. Submit an update request to change a published listing.'});
  const files=(req.files||[]) as Express.Multer.File[];
  if(!files.length)return res.status(400).json({error:'Choose at least one image.'});
  for(const file of files){if(!(await validFileSignature(file))){await Promise.all(files.map(f=>fs.promises.unlink(f.path).catch(()=>{})));return res.status(400).json({error:'One of the uploaded images does not match its file type.'});}}
  if(listing.images.length+files.length>12)return res.status(400).json({error:'A property can have a maximum of 12 images.'});
  const urls=files.map(f=>`${API_PUBLIC_ORIGIN}/media/properties/${path.basename(f.path)}`);
  const images=[...listing.images,...urls];
  const updated=await prisma.property.update({where:{id:listing.id},data:{images,coverImageUrl:listing.coverImageUrl||images[0]}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'PROPERTY_IMAGES_UPLOADED',targetType:'Property',targetId:listing.id,metadata:{count:files.length}}});
  res.status(201).json({images:updated.images,coverImageUrl:updated.coverImageUrl});
}));
app.get('/api/admin/listings/review',auth,allow(Role.ADMIN),asyncRoute(async(_req,res)=>{
  const rows=await prisma.property.findMany({where:{status:ListingStatus.PENDING_REVIEW},include:{owner:{select:{id:true,name:true,email:true,phone:true,agentProfile:{select:{verificationStatus:true,agencyName:true}}}}},orderBy:{createdAt:'asc'}});
  res.json(rows.map(p=>({...p,priceNaira:p.priceNaira.toString()})));
}));
app.post('/api/admin/listings/:id/review',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const data=z.object({decision:z.enum(['APPROVED','REJECTED']),note:z.string().trim().min(5).max(500)}).parse(req.body);
  const listing=await prisma.property.findUnique({where:{id:req.params.id}});
  if(!listing)return res.status(404).json({error:'Listing not found.'});
  if(listing.status!==ListingStatus.PENDING_REVIEW)return res.status(409).json({error:'This listing is no longer awaiting review.'});
  if(data.decision==='APPROVED'){const owner=await prisma.user.findUnique({where:{id:listing.ownerId},include:{agentProfile:true}});if(!owner||owner.accountStatus!==AgentAccountStatus.ACTIVE||owner.agentProfile?.verificationStatus!==VerificationStatus.APPROVED)return res.status(409).json({error:'This advertiser must have active account access and approved marketplace verification before a property can be published.'});}
  const updated=await prisma.property.update({where:{id:listing.id},data:{status:data.decision==='APPROVED'?ListingStatus.PUBLISHED:ListingStatus.REJECTED}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:`PROPERTY_${data.decision}`,targetType:'Property',targetId:listing.id,metadata:{note:data.note}}});
  res.json({id:updated.id,status:updated.status,note:data.note});
}));

// Customer saved properties. Only published listings can be saved.
app.get('/api/customer/favorites',auth,allow(Role.CUSTOMER),asyncRoute(async(req,res)=>{
  const rows=await prisma.favorite.findMany({where:{userId:req.user!.id,property:{status:ListingStatus.PUBLISHED,deletedAt:null}},include:{property:{include:{owner:{select:{id:true,name:true,agentProfile:{select:{verificationStatus:true,agencyName:true}}}}}}},orderBy:{createdAt:'desc'}});
  res.json(rows.map(row=>({...row.property,priceNaira:row.property.priceNaira.toString(),savedAt:row.createdAt})));
}));
app.post('/api/customer/favorites/:propertyId',auth,allow(Role.CUSTOMER),asyncRoute(async(req,res)=>{
  const property=await prisma.property.findFirst({where:{id:req.params.propertyId,status:ListingStatus.PUBLISHED},select:{id:true}});
  if(!property)return res.status(404).json({error:'This property is not available to save.'});
  await prisma.favorite.upsert({where:{userId_propertyId:{userId:req.user!.id,propertyId:property.id}},create:{userId:req.user!.id,propertyId:property.id},update:{}});
  res.status(201).json({saved:true,propertyId:property.id});
}));
app.delete('/api/customer/favorites/:propertyId',auth,allow(Role.CUSTOMER),asyncRoute(async(req,res)=>{
  await prisma.favorite.deleteMany({where:{userId:req.user!.id,propertyId:req.params.propertyId}});
  res.json({saved:false,propertyId:req.params.propertyId});
}));

app.post('/api/properties/:id/enquiries',auth,allow(Role.CUSTOMER),asyncRoute(async(req,res)=>{const data=z.object({message:z.string().trim().min(10).max(1500)}).parse(req.body);const property=await prisma.property.findFirst({where:{id:req.params.id,status:ListingStatus.PUBLISHED,deletedAt:null}});if(!property)return res.status(404).json({error:'Property is no longer available.'});if(property.ownerId===req.user!.id)return res.status(400).json({error:'You cannot enquire about your own listing.'});const enquiry=await prisma.enquiry.create({data:{message:data.message,customerId:req.user!.id,propertyId:property.id}});res.status(201).json({id:enquiry.id,message:'Your enquiry has been sent.'});}));
app.get('/api/agent/enquiries',auth,allow(Role.AGENT),asyncRoute(async(req,res)=>{const rows=await prisma.enquiry.findMany({where:{property:{ownerId:req.user!.id}},include:{customer:{select:{name:true,email:true,phone:true}},property:{select:{id:true,title:true}}},orderBy:{createdAt:'desc'}});res.json(rows);}));


// -----------------------------------------------------------------------------
// Buyer/seller messaging. Messages are append-only; no edit/delete endpoint exists.
// Admin access is limited to reported conversations and is written to the audit log.
// -----------------------------------------------------------------------------
app.post('/api/conversations', auth, allow(Role.CUSTOMER), asyncRoute(async (req,res) => {
  const { propertyId } = z.object({ propertyId:z.string().min(1) }).parse(req.body);
  const property = await prisma.property.findFirst({ where:{ id:propertyId, status:ListingStatus.PUBLISHED, deletedAt:null } });
  if (!property) return res.status(404).json({error:'This property is no longer available.'});
  if (property.ownerId === req.user!.id) return res.status(400).json({error:'You cannot start a conversation about your own property.'});
  const conversation = await prisma.conversation.upsert({ where:{propertyId_buyerId:{propertyId,buyerId:req.user!.id}}, create:{propertyId,buyerId:req.user!.id,sellerId:property.ownerId}, update:{}, include:{property:{select:{id:true,title:true,coverImageUrl:true}},seller:{select:{id:true,name:true}}} });
  res.status(201).json(conversation);
}));
app.get('/api/conversations', auth, asyncRoute(async(req,res) => {
  const rows = await prisma.conversation.findMany({ where:{OR:[{buyerId:req.user!.id},{sellerId:req.user!.id}]}, include:{property:{select:{id:true,title:true,city:true,state:true,coverImageUrl:true}},buyer:{select:{id:true,name:true}},seller:{select:{id:true,name:true}},messages:{orderBy:{createdAt:'desc'},take:1}}, orderBy:{updatedAt:'desc'} });
  res.json(rows.map(c=>({...c,messages:c.messages.map(m=>({...m,body:m.body.slice(0,180)}))})));
}));
app.get('/api/conversations/:id/messages', auth, asyncRoute(async(req,res) => {
  const c = await prisma.conversation.findUnique({where:{id:req.params.id},select:{id:true,buyerId:true,sellerId:true}});
  if(!c)return res.status(404).json({error:'Conversation not found.'});
  if(c.buyerId!==req.user!.id && c.sellerId!==req.user!.id)return res.status(403).json({error:'You are not a participant in this conversation.'});
  const rows = await prisma.message.findMany({where:{conversationId:c.id},include:{sender:{select:{id:true,name:true,role:true}}},orderBy:{createdAt:'asc'},take:500});
  await prisma.message.updateMany({where:{conversationId:c.id,senderId:{not:req.user!.id},readAt:null},data:{readAt:new Date()}});
  res.json(rows);
}));
app.post('/api/conversations/:id/messages', auth, asyncRoute(async(req,res) => {
  const {body} = z.object({body:z.string().trim().min(1).max(4000)}).parse(req.body);
  const c = await prisma.conversation.findUnique({where:{id:req.params.id}});
  if(!c)return res.status(404).json({error:'Conversation not found.'});
  if(c.buyerId!==req.user!.id && c.sellerId!==req.user!.id)return res.status(403).json({error:'You are not a participant in this conversation.'});
  const [message] = await prisma.$transaction([
    prisma.message.create({data:{conversationId:c.id,senderId:req.user!.id,body},include:{sender:{select:{id:true,name:true,role:true}}}}),
    prisma.conversation.update({where:{id:c.id},data:{updatedAt:new Date()}})
  ]);
  res.status(201).json(message);
}));
app.post('/api/conversations/:id/report', auth, asyncRoute(async(req,res) => {
  const data=z.object({reason:z.string().trim().min(3).max(120),details:z.string().trim().max(2000).optional()}).parse(req.body);
  const c=await prisma.conversation.findUnique({where:{id:req.params.id}});
  if(!c)return res.status(404).json({error:'Conversation not found.'});
  if(c.buyerId!==req.user!.id && c.sellerId!==req.user!.id)return res.status(403).json({error:'Only participants can report this conversation.'});
  const report=await prisma.report.create({data:{reporterId:req.user!.id,targetType:ReportTargetType.CONVERSATION,targetId:c.id,conversationId:c.id,reason:data.reason,details:data.details}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'CONVERSATION_REPORTED',targetType:'Conversation',targetId:c.id,metadata:{reportId:report.id}}});
  res.status(201).json({id:report.id,status:report.status,message:'Report submitted. The conversation record has been preserved for review.'});
}));

// -----------------------------------------------------------------------------
// Expanded administration. Destructive property actions are soft deletes.
// -----------------------------------------------------------------------------
app.get('/api/admin/agents',auth,allow(Role.ADMIN),asyncRoute(async(req,res)=>{
  const q=String(req.query.q||'').trim();
  const rows=await prisma.user.findMany({where:{role:Role.AGENT,...(q?{OR:[{name:{contains:q,mode:'insensitive'}},{email:{contains:q,mode:'insensitive'}},{phone:{contains:q,mode:'insensitive'}},{agentProfile:{agencyName:{contains:q,mode:'insensitive'}}}]}:{})},include:{agentProfile:true,_count:{select:{listings:true}}},orderBy:{createdAt:'desc'},take:200});
  res.json(rows.map(u=>({id:u.id,name:u.name,email:u.email,phone:u.phone,createdAt:u.createdAt,accountStatus:u.accountStatus,suspensionReason:u.suspensionReason,adminLevel:u.adminLevel,propertyCount:u._count.listings,agentProfile:u.agentProfile?{id:u.agentProfile.id,agencyName:u.agentProfile.agencyName,registrationNumber:u.agentProfile.registrationNumber,verificationStatus:u.agentProfile.verificationStatus,reviewNote:u.agentProfile.reviewNote,submittedAt:u.agentProfile.submittedAt,reviewedAt:u.agentProfile.reviewedAt}:null})));
}));
app.post('/api/admin/agents/:id/revoke',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);
  const profile=await prisma.agentProfile.findUnique({where:{userId:req.params.id}});if(!profile)return res.status(404).json({error:'Agent profile not found.'});
  const updated=await prisma.agentProfile.update({where:{id:profile.id},data:{verificationStatus:VerificationStatus.REVOKED,reviewNote:reason,reviewedAt:new Date(),reviewedById:req.user!.id}});
  await prisma.property.updateMany({where:{ownerId:req.params.id,status:ListingStatus.PUBLISHED},data:{status:ListingStatus.PAUSED}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'AGENT_VERIFICATION_REVOKED',targetType:'AgentProfile',targetId:profile.id,metadata:{reason}}});
  res.json({status:updated.verificationStatus,message:'Marketplace agent verification revoked. Existing records have been retained.'});
}));
app.post('/api/admin/agents/:id/restore-verification',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);
  const profile=await prisma.agentProfile.findUnique({where:{userId:req.params.id}});if(!profile)return res.status(404).json({error:'Agent profile not found.'});
  const updated=await prisma.agentProfile.update({where:{id:profile.id},data:{verificationStatus:VerificationStatus.APPROVED,reviewNote:reason,reviewedAt:new Date(),reviewedById:req.user!.id}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'AGENT_VERIFICATION_RESTORED',targetType:'AgentProfile',targetId:profile.id,metadata:{reason}}});res.json({status:updated.verificationStatus});
}));
app.post('/api/admin/agents/:id/suspend',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);
  const user=await prisma.user.findFirst({where:{id:req.params.id,role:Role.AGENT}});if(!user)return res.status(404).json({error:'Agent account not found.'});
  await prisma.user.update({where:{id:user.id},data:{accountStatus:AgentAccountStatus.SUSPENDED,suspendedAt:new Date(),suspensionReason:reason}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'AGENT_ACCOUNT_SUSPENDED',targetType:'User',targetId:user.id,metadata:{reason}}});res.json({status:'SUSPENDED'});
}));
app.post('/api/admin/agents/:id/activate',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const user=await prisma.user.findFirst({where:{id:req.params.id,role:Role.AGENT}});if(!user)return res.status(404).json({error:'Agent account not found.'});
  await prisma.user.update({where:{id:user.id},data:{accountStatus:AgentAccountStatus.ACTIVE,suspendedAt:null,suspensionReason:null}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'AGENT_ACCOUNT_REACTIVATED',targetType:'User',targetId:user.id}});res.json({status:'ACTIVE'});
}));
app.get('/api/admin/properties',auth,allow(Role.ADMIN),asyncRoute(async(req,res)=>{
  const q=String(req.query.q||'').trim();const status=String(req.query.status||'');
  const rows=await prisma.property.findMany({where:{...(status&&Object.values(ListingStatus).includes(status as ListingStatus)?{status:status as ListingStatus}:{}),...(q?{OR:[{title:{contains:q,mode:'insensitive'}},{city:{contains:q,mode:'insensitive'}},{state:{contains:q,mode:'insensitive'}},{owner:{name:{contains:q,mode:'insensitive'}}}]}:{})},include:{owner:{select:{id:true,name:true,email:true,phone:true}}},orderBy:{createdAt:'desc'},take:300});
  res.json(rows.map(p=>({...p,priceNaira:p.priceNaira.toString()})));
}));
app.delete('/api/admin/properties/:id',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const {reason}=z.object({reason:z.string().trim().min(5).max(500)}).parse(req.body);
  const p=await prisma.property.findUnique({where:{id:req.params.id}});if(!p)return res.status(404).json({error:'Property not found.'});if(p.deletedAt)return res.status(409).json({error:'Property is already removed.'});
  await prisma.property.update({where:{id:p.id},data:{deletedAt:new Date(),deletedById:req.user!.id,deletionReason:reason,status:ListingStatus.PAUSED}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'PROPERTY_SOFT_DELETED',targetType:'Property',targetId:p.id,metadata:{reason}}});res.json({removed:true,message:'Property removed from public view. Related messages and audit records were preserved.'});
}));
app.post('/api/admin/properties/:id/restore',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const {status}=z.object({status:z.enum(['PENDING_REVIEW','PAUSED'])}).parse(req.body);
  const p=await prisma.property.findUnique({where:{id:req.params.id}});if(!p)return res.status(404).json({error:'Property not found.'});
  await prisma.property.update({where:{id:p.id},data:{deletedAt:null,deletedById:null,deletionReason:null,status}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'PROPERTY_RESTORED',targetType:'Property',targetId:p.id,metadata:{status}}});res.json({restored:true,status});
}));
app.get('/api/admin/reports',auth,allow(Role.ADMIN),asyncRoute(async(_req,res)=>{
  const rows=await prisma.report.findMany({include:{reporter:{select:{id:true,name:true,email:true}},assignedAdmin:{select:{id:true,name:true}},conversation:{select:{id:true,property:{select:{title:true}},buyer:{select:{name:true}},seller:{select:{name:true}}}}},orderBy:{createdAt:'desc'},take:200});res.json(rows);
}));
app.patch('/api/admin/reports/:id',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.SUPPORT_ADMIN),asyncRoute(async(req,res)=>{
  const data=z.object({status:z.nativeEnum(ReportStatus),note:z.string().trim().min(5).max(1000)}).parse(req.body);
  const report=await prisma.report.update({where:{id:req.params.id},data:{status:data.status,resolutionNote:data.note,assignedAdminId:req.user!.id}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'REPORT_UPDATED',targetType:'Report',targetId:report.id,metadata:{status:data.status,note:data.note}}});res.json(report);
}));
app.post('/api/admin/reports/:id/conversation/access',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const {reason}=z.object({reason:z.string().trim().min(10).max(500)}).parse(req.body);
  const report=await prisma.report.findUnique({where:{id:req.params.id},include:{conversation:{include:{property:{select:{id:true,title:true}},buyer:{select:{id:true,name:true,email:true}},seller:{select:{id:true,name:true,email:true}}}}}});
  if(!report||report.targetType!==ReportTargetType.CONVERSATION||!report.conversation)return res.status(404).json({error:'Reported conversation not found.'});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'ADMIN_ACCESSED_REPORTED_CONVERSATION',targetType:'Conversation',targetId:report.conversation.id,metadata:{reportId:report.id,reason}}});
  const messages=await prisma.message.findMany({where:{conversationId:report.conversation.id},include:{sender:{select:{id:true,name:true,email:true}}},orderBy:{createdAt:'asc'},take:1000});res.json({conversation:report.conversation,messages});
}));
app.get('/api/admin/audit-logs',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.ADMIN),asyncRoute(async(req,res)=>{
  const rows=await prisma.auditLog.findMany({orderBy:{createdAt:'desc'},take:300});
}));

app.post('/api/reports',auth,asyncRoute(async(req,res)=>{
  const data=z.object({targetType:z.enum(['PROPERTY','AGENT','USER']),targetId:z.string().min(1),reason:z.string().trim().min(3).max(120),details:z.string().trim().max(2000).optional()}).parse(req.body);
  if(data.targetType==='PROPERTY'&&!await prisma.property.findUnique({where:{id:data.targetId},select:{id:true}}))return res.status(404).json({error:'Property not found.'});
  if(data.targetType!=='PROPERTY'&&!await prisma.user.findUnique({where:{id:data.targetId},select:{id:true}}))return res.status(404).json({error:'Account not found.'});
  const report=await prisma.report.create({data:{reporterId:req.user!.id,targetType:data.targetType,targetId:data.targetId,reason:data.reason,details:data.details}});
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'USER_REPORT_SUBMITTED',targetType:data.targetType,targetId:data.targetId,metadata:{reportId:report.id}}});res.status(201).json({id:report.id,status:report.status});
}));
app.get('/api/admin/admins',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.SUPER_ADMIN),asyncRoute(async(_req,res)=>{
 const rows=await prisma.user.findMany({where:{role:Role.ADMIN},select:{id:true,name:true,email:true,adminLevel:true,createdAt:true,accountStatus:true},orderBy:{createdAt:'asc'}});res.json(rows);
}));
app.patch('/api/admin/admins/:id/level',auth,allow(Role.ADMIN),requireAdminLevel(AdminLevel.SUPER_ADMIN),asyncRoute(async(req,res)=>{
 const {level}=z.object({level:z.nativeEnum(AdminLevel)}).parse(req.body);if(req.params.id===req.user!.id&&level!==AdminLevel.SUPER_ADMIN)return res.status(400).json({error:'You cannot remove your own Super Admin access.'});
 const target=await prisma.user.findFirst({where:{id:req.params.id,role:Role.ADMIN}});if(!target)return res.status(404).json({error:'Administrator not found.'});
 const updated=await prisma.user.update({where:{id:target.id},data:{adminLevel:level}});await prisma.auditLog.create({data:{actorId:req.user!.id,action:'ADMIN_LEVEL_CHANGED',targetType:'User',targetId:target.id,metadata:{level}}});res.json({id:updated.id,adminLevel:updated.adminLevel});
}));

// Admin overview metrics. Counts are aggregate-only; no private applicant documents are exposed.
app.get('/api/admin/analytics',auth,allow(Role.ADMIN),asyncRoute(async(_req,res)=>{
  const [users,agents,pendingAgents,published,pendingListings,enquiries,favorites]=await Promise.all([
    prisma.user.count(), prisma.user.count({where:{role:Role.AGENT}}),
    prisma.agentProfile.count({where:{verificationStatus:{in:[VerificationStatus.PENDING,VerificationStatus.UNDER_REVIEW]}}}),
    prisma.property.count({where:{status:ListingStatus.PUBLISHED}}),
    prisma.property.count({where:{status:ListingStatus.PENDING_REVIEW}}),
    prisma.enquiry.count(), prisma.favorite.count()
  ]);
  res.json({users,agents,pendingAgents,publishedListings:published,pendingListings,enquiries,favorites});
}));

// Subscription billing uses Paystack hosted checkout. The platform never collects rent or sale deposits.
const plans = {
  STARTER:{name:'Starter',amountNaira:5000,durationDays:30,listingLimit:5,featuredSlots:0},
  GROWTH:{name:'Growth',amountNaira:15000,durationDays:30,listingLimit:25,featuredSlots:2},
  PREMIUM:{name:'Premium',amountNaira:35000,durationDays:30,listingLimit:100,featuredSlots:10}
} as const;
app.get('/api/agent/billing/plans',auth,allow(Role.AGENT),(_req,res)=>res.json(Object.entries(plans).map(([id,p])=>({id,...p,currency:'NGN'}))));
app.get('/api/agent/billing/current',auth,allow(Role.AGENT),asyncRoute(async(req,res)=>{
  const subscription=await prisma.subscription.findFirst({where:{userId:req.user!.id,status:'ACTIVE',endsAt:{gt:new Date()}},orderBy:{endsAt:'desc'}});
  res.json({subscription});
}));
app.post('/api/agent/billing/checkout',auth,allow(Role.AGENT),asyncRoute(async(req,res)=>{
  const key=process.env.PAYSTACK_SECRET_KEY;
  if(!key)return res.status(503).json({error:'Online payments are not configured yet. Add PAYSTACK_SECRET_KEY to the server environment.'});
  const {plan}=z.object({plan:z.enum(['STARTER','GROWTH','PREMIUM'])}).parse(req.body);
  const selected=plans[plan];
  const user=await prisma.user.findUnique({where:{id:req.user!.id},select:{email:true}});
  if(!user)return res.status(404).json({error:'Account not found.'});
  const reference=`pc_${crypto.randomUUID().replaceAll('-','')}`;
  const amountKobo=BigInt(selected.amountNaira)*100n;
  const pending=await prisma.subscription.create({data:{userId:req.user!.id,plan,status:'PENDING'}});
  await prisma.payment.create({data:{userId:req.user!.id,subscriptionId:pending.id,reference,amountKobo}});
  const response=await fetch('https://api.paystack.co/transaction/initialize',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,amount:Number(amountKobo),reference,callback_url:process.env.PAYSTACK_CALLBACK_URL||`${ORIGIN}/?billing=return` ,metadata:{userId:req.user!.id,subscriptionId:pending.id,plan}})});
  const result=await response.json() as {status?:boolean;message?:string;data?:{authorization_url?:string;reference?:string}};
  if(!response.ok||!result.status||!result.data?.authorization_url){await prisma.payment.update({where:{reference},data:{status:'FAILED'}});return res.status(502).json({error:result.message||'Payment provider could not start checkout.'});}
  res.status(201).json({authorizationUrl:result.data.authorization_url,reference});
}));
app.get('/api/agent/billing/verify/:reference',auth,allow(Role.AGENT),asyncRoute(async(req,res)=>{
  const key=process.env.PAYSTACK_SECRET_KEY;
  if(!key)return res.status(503).json({error:'Online payments are not configured.'});
  const payment=await prisma.payment.findFirst({where:{reference:req.params.reference,userId:req.user!.id},include:{subscription:true}});
  if(!payment)return res.status(404).json({error:'Payment reference not found.'});
  if(payment.status==='SUCCESS')return res.json({verified:true,status:'SUCCESS'});
  const response=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(payment.reference)}`,{headers:{Authorization:`Bearer ${key}`}});
  const result=await response.json() as {status?:boolean;message?:string;data?:{status?:string;amount?:number;currency?:string;reference?:string;paid_at?:string}};
  const paid=result.data?.status==='success' && result.data.reference===payment.reference && BigInt(result.data.amount||0)===payment.amountKobo && result.data.currency==='NGN';
  if(!response.ok||!result.status)return res.status(502).json({error:result.message||'Could not verify payment with the provider.'});
  if(!paid){await prisma.payment.update({where:{id:payment.id},data:{status:'FAILED'}});return res.status(402).json({verified:false,error:'Payment has not been confirmed. If you were charged, contact support with your reference.'});}
  const now=new Date();
  await prisma.$transaction([
    prisma.payment.update({where:{id:payment.id},data:{status:'SUCCESS',paidAt:result.data?.paid_at?new Date(result.data.paid_at):now}}),
    prisma.subscription.update({where:{id:payment.subscriptionId!},data:{status:'ACTIVE',startsAt:now,endsAt:new Date(now.getTime()+30*86400000)}})
  ]);
  await prisma.auditLog.create({data:{actorId:req.user!.id,action:'SUBSCRIPTION_PAYMENT_CONFIRMED',targetType:'Subscription',targetId:payment.subscriptionId!,metadata:{reference:payment.reference,amountKobo:payment.amountKobo.toString()}}});
  res.json({verified:true,status:'SUCCESS',plan:payment.subscription!.plan});
}));

app.use((err:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  if(err instanceof z.ZodError)return res.status(400).json({error:'Please check the information you entered.',details:err.issues.map(i=>({field:i.path.join('.'),message:i.message}))});
  if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'File exceeds the allowed upload size.':'Upload could not be processed.'});
  if(err instanceof Error && (err.message.includes('Only PDF') || err.message.includes('Property images')))return res.status(400).json({error:err.message});
  console.error(err);res.status(500).json({error:'Something went wrong. Please try again.'});
});
app.listen(PORT,()=>console.log(`Sham Haven API running at http://localhost:${PORT}`));
