import {at,indexSketch} from './model.js';
import {distance,signedDistance,footOnLine,mod} from './geom2d.js';
export const midpoint=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
export function measure(s,c){const ix=indexSketch(s),[a,b]=c.refs,A=ix.entity(a),B=ix.entity(b);
 if(c.type==='distance'){const p=at(s,a),q=at(s,b);return c.mode==='h'?Math.abs(q[0]-p[0]):c.mode==='v'?Math.abs(q[1]-p[1]):distance(p,q);}
 if(c.type==='distancePL')return Math.abs(signedDistance(at(s,a),at(s,B.a),at(s,B.b)));
 if(['radius','diameter'].includes(c.type)){const r=A.type==='circle'?A.r:distance(at(s,A.c),at(s,A.a));return r*(c.type==='diameter'?2:1);}
 if(c.type==='angle'){const x=at(s,A.a),y=at(s,A.b),u=at(s,B.a),v=at(s,B.b);return mod(Math.atan2(v[1]-u[1],v[0]-u[0])-Math.atan2(y[1]-x[1],y[0]-x[0])+(c.flipB?Math.PI:0)-(c.flipA?Math.PI:0))*180/Math.PI;}
 return 0;
}
export function dimensionFrom(s,ids,mode='auto'){
 const ix=indexSketch(s),items=ids.map(id=>ix.entity(id)),points=ids.filter(id=>ix.point(id)),lines=items.filter(e=>e?.type==='line'),curves=items.filter(e=>['circle','arc'].includes(e?.type));let c;
 if(ids.length===1&&lines.length===1){const l=lines[0],a=at(s,l.a),b=at(s,l.b);const m=mode==='auto'?(Math.abs(a[1]-b[1])<1e-6?'h':Math.abs(a[0]-b[0])<1e-6?'v':'aligned'):mode;c={type:'distance',refs:[l.a,l.b],mode:m,dir:(m==='v'?b[1]-a[1]:b[0]-a[0])>=0?1:-1};}
 else if(ids.length===1&&curves.length)c={type:mode==='diameter'?'diameter':'radius',refs:ids};
 else if(points.length===2){const a=at(s,points[0]),b=at(s,points[1]),m=mode==='auto'?'aligned':mode;c={type:'distance',refs:points,mode:m,dir:(m==='v'?b[1]-a[1]:b[0]-a[0])>=0?1:-1};}
 else if(points.length===1&&lines.length===1){const l=lines[0];c={type:'distancePL',refs:[points[0],l.id],side:signedDistance(at(s,points[0]),at(s,l.a),at(s,l.b))>=0?1:-1};}
 else if(lines.length===2)c={type:'angle',refs:lines.map(e=>e.id)};
 else throw Error('Select one line or circle, two points, a point and line, or two lines. Shift-click adds to the selection.');
 c.value=measure(s,c);c.label=c.mode==='v'?[8,0]:[0,-8];return c;
}
export function dimensionGeometry(s,c){const ix=indexSketch(s),[a,b]=c.refs,A=ix.entity(a),B=ix.entity(b);let p,q;
 if(c.type==='distance'){p=at(s,a);q=at(s,b);}
 else if(c.type==='distancePL'){p=at(s,a);q=footOnLine(p,at(s,B.a),at(s,B.b)).p;}
 else if(['radius','diameter'].includes(c.type)){p=at(s,A.c);const r=A.type==='circle'?A.r:distance(p,at(s,A.a));q=[p[0]+r*.7071,p[1]+r*.7071];}
 else {p=midpoint(at(s,A.a),at(s,A.b));q=midpoint(at(s,B.a),at(s,B.b));}
 const mid=midpoint(p,q),off=c.label??[0,-8],label=[mid[0]+off[0],mid[1]+off[1]];let a2=p,b2=q;
 if(c.type==='distance'){if(c.mode==='h'){a2=[p[0],label[1]];b2=[q[0],label[1]];label[0]=mid[0];}else if(c.mode==='v'){a2=[label[0],p[1]];b2=[label[0],q[1]];label[1]=mid[1];}else{a2=[p[0]+off[0],p[1]+off[1]];b2=[q[0]+off[0],q[1]+off[1]];}}
 return{p,q,a:a2,b:b2,label,mid};
}
