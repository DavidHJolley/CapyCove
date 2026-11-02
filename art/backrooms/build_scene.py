import bpy, math, random, os
from mathutils import Vector

random.seed(17)
OUT = os.path.dirname(os.path.abspath(__file__))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for data in list(bpy.data.materials):
    bpy.data.materials.remove(data)

def material(name, color, roughness=0.85):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*color,1); p.inputs['Roughness'].default_value=roughness
    return m

def textured(name, dark, light, scale, bump):
    m=material(name, light); n=m.node_tree.nodes; l=m.node_tree.links; p=n.get('Principled BSDF')
    coord=n.new('ShaderNodeTexCoord')
    noise=n.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value=scale; noise.inputs['Detail'].default_value=4
    l.new(coord.outputs['Object'],noise.inputs['Vector'])
    ramp=n.new('ShaderNodeValToRGB'); ramp.color_ramp.elements[0].position=.18; ramp.color_ramp.elements[0].color=(*dark,1); ramp.color_ramp.elements[1].position=.82; ramp.color_ramp.elements[1].color=(*light,1)
    l.new(noise.outputs['Fac'],ramp.inputs[0]); l.new(ramp.outputs[0],p.inputs['Base Color'])
    fine=n.new('ShaderNodeTexNoise'); fine.inputs['Scale'].default_value=160; l.new(coord.outputs['Object'],fine.inputs['Vector'])
    b=n.new('ShaderNodeBump'); b.inputs['Strength'].default_value=bump; b.inputs['Distance'].default_value=.025; l.new(fine.outputs['Fac'],b.inputs['Height']); l.new(b.outputs[0],p.inputs['Normal'])
    return m

wall=textured('01 | nicotine yellow woven wallpaper',(.29,.235,.071),(.59,.49,.22),1.9,.23)
# Fine repeated vertical wallpaper grain, mixed with the uneven aged pigment.
n=wall.node_tree.nodes; l=wall.node_tree.links; p=n.get('Principled BSDF'); old=p.inputs['Base Color'].links[0].from_socket
tex=n.new('ShaderNodeTexCoord'); wave=n.new('ShaderNodeTexWave'); wave.bands_direction='X'; wave.inputs['Scale'].default_value=52; wave.inputs['Distortion'].default_value=3; l.new(tex.outputs['Object'],wave.inputs['Vector'])
mix=n.new('ShaderNodeMixRGB'); mix.blend_type='MULTIPLY'; mix.inputs[0].default_value=.17; l.new(old,mix.inputs[1]); l.new(wave.outputs['Color'],mix.inputs[2]); l.new(mix.outputs[0],p.inputs['Base Color'])
carpet=textured('02 | damp mottled ochre carpet',(.105,.084,.037),(.29,.25,.12),1.1,.8)
tile=textured('03 | acoustic ceiling mineral fiber',(.32,.32,.25),(.62,.61,.48),6,.48)
trim=material('04 | aged vinyl skirting',(.21,.18,.087))
grid=material('05 | ceiling aluminum T rails',(.37,.37,.29),.55)
metal=material('06 | fluorescent fixture housing',(.50,.51,.43),.4)
black=material('07 | dead ballast and ventilation',(.028,.029,.022))
paper=material('08 | abandoned paper',(.48,.43,.28))
lightmat=material('09 | fluorescent diffuser',(.8,.85,.65))
p=lightmat.node_tree.nodes.get('Principled BSDF'); p.inputs['Emission Color'].default_value=(.86,1,.69,1); p.inputs['Emission Strength'].default_value=4

def box(name, loc, dims, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc); o=bpy.context.object; o.name=name; o.dimensions=dims; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); o.data.materials.append(mat)
    if bevel:
        mod=o.modifiers.new('small worn edge','BEVEL'); mod.width=bevel; mod.segments=2
        o.modifiers.new('weighted normals','WEIGHTED_NORMAL')
    return o

H=2.82
box('Continuous stained carpet', (0,7,-.09),(20,36,.18),carpet)
def partition(name,x,y,w,d):
    box(name,(x,y,H/2),(w,d,H),wall,.012)
    box(name+' | floor skirting',(x,y,.065),(w+.025,d+.025,.13),trim,.007)

partition('Left enclosing wall',-5,7,.22,36)
partition('Right enclosing wall',7,7,.22,36)
partition('Far end wall',1,24,12,.22)
partition('Behind camera',1,-11,12,.22)
partition('Foreground left blind return',-3.4,-1.8,3.2,.25)
partition('Central partition',1.85,6.0,.28,8.1)
partition('Central partition return',3.8,10,4.2,.28)
partition('Left room divider',-3.5,9.6,3,.24)
partition('Rear corridor edge',-.8,17,.26,8)
partition('Rear dead end return',-2.5,21,3.5,.25)
partition('Right distant divider',5.4,17,3.2,.24)
for i,(x,y) in enumerate([(-1.7,2.8),(4.7,1.6),(-1.7,13.6),(4.7,13.6),(1.6,20.5)]):
    partition('Square structural pier %02d'%i,x,y,.6,.6)

# Individually modeled drop-ceiling panels and exposed suspension grid.
for ix in range(10):
    x=-4.4+ix*1.2
    for iy in range(29):
        y=-10.4+iy*1.2
        box('Acoustic panel %02d %02d'%(ix,iy),(x,y,H+.035),(1.176,1.176,.065),tile)
for ix in range(11):
    box('Long ceiling rail %02d'%ix,(-5+ix*1.2,6.4,H-.007),(.023,34.8,.028),grid)
for iy in range(30):
    box('Cross ceiling rail %02d'%iy,(1,-11+iy*1.2,H-.008),(12,.023,.028),grid)

def fixture(x,y,index,energy=105):
    box('Troffer rim %02d'%index,(x,y,H-.045),(1.13,.57,.095),metal,.016)
    box('Prismatic diffuser %02d'%index,(x,y,H-.099),(1.04,.48,.018),lightmat if energy else black,.008)
    for dx in [-.49,.49]: box('Diffuser endcap',(x+dx,y,H-.11),(.028,.48,.018),metal)
    if energy:
        data=bpy.data.lights.new('Fluorescent pool %02d'%index,'AREA'); data.energy=energy; data.shape='RECTANGLE'; data.size=1.02; data.size_y=.46; data.color=(1,.91,.64) if index%3 else (.84,1,.78)
        o=bpy.data.objects.new(data.name,data); bpy.context.collection.objects.link(o); o.location=(x,y,H-.13)
for i,(x,y,e) in enumerate([(-2,-4.4,125),(2.8,-3.2,90),(-.8,.4,135),(4,4,100),(-3.2,5.2,85),(-.8,7.6,110),(4,8.8,0),(-3.2,12.4,90),(.4,13.6,100),(5.2,14.8,65),(-3.2,18.4,80),(2.8,20.8,70),(.4,23.2,40)]): fixture(x,y,i,e)

# A few quiet environmental details, without breaking the emptiness.
for x,y in [(-4.87,3.5),(1.695,5.8),(6.875,8.2)]:
    box('Old wall outlet',(x,y,.34),(.028,.10,.14),trim,.009)
    for z in [.315,.365]: box('Outlet dark socket',(x-.017,y,z),(.008,.033,.017),black)
box('Air return recess',(-3.2,7.6,H-.015),(.53,.53,.035),black)
for j in range(10): box('Air return slat',(-3.2,7.36+j*.053,H-.046),(.51,.018,.016),metal)
for i in range(3):
    o=box('Discarded paper %d'%i,(5.7+i*.16,6.4+i*.18,.007),(.20,.28,.004),paper); o.rotation_euler.z=random.uniform(-1,1)

bpy.ops.object.camera_add(location=(-.35,-6.5,1.63)); cam=bpy.context.object; cam.name='CAM | found footage handheld'; target=Vector((.0,7.4,1.48)); cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler(); cam.rotation_euler.rotate_axis('Z',math.radians(-1.4)); cam.data.lens=23; cam.data.sensor_width=36
scene=bpy.context.scene; scene.camera=cam
scene.render.engine='CYCLES'; scene.cycles.samples=48; scene.cycles.use_denoising=True; scene.cycles.max_bounces=7
scene.render.resolution_x=1200; scene.render.resolution_y=900; scene.render.resolution_percentage=100
scene.world.color=(.035,.035,.025)
scene.view_settings.view_transform='AgX'; scene.view_settings.exposure=.45
scene.render.image_settings.file_format='PNG'; scene.render.filepath=os.path.join(OUT,'backrooms.png')
# Blender 5 compositor group API.
group=bpy.data.node_groups.new('Found footage optical finish','CompositorNodeTree'); group.interface.new_socket(name='Image',in_out='OUTPUT',socket_type='NodeSocketColor'); scene.compositing_node_group=group
n=group.nodes; l=group.links; render=n.new('CompositorNodeRLayers'); lens=n.new('CompositorNodeLensdist'); lens.inputs['Distortion'].default_value=.012; lens.inputs['Dispersion'].default_value=.006; l.new(render.outputs['Image'],lens.inputs['Image'])
glow=n.new('CompositorNodeGlare'); glow.inputs['Type'].default_value='Fog Glow'; glow.inputs['Quality'].default_value='High'; glow.inputs['Strength'].default_value=.22; l.new(lens.outputs['Image'],glow.inputs['Image'])
out=n.new('NodeGroupOutput'); l.new(glow.outputs['Image'],out.inputs['Image'])
scene['description']='Original liminal office environment inspired by Backrooms found-footage cinematography. Procedural materials; no downloaded assets.'
scene['controls']='Numpad 0: camera view. Z then R: rendered viewport. F12: render.'
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type=='VIEW_3D':
            area.spaces.active.region_3d.view_perspective='CAMERA'; area.spaces.active.shading.type='MATERIAL'
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'backrooms.blend'))
bpy.ops.render.render(write_still=True)
