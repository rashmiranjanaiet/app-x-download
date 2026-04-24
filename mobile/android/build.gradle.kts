allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val rootBuildDirectory = rootProject.layout.buildDirectory.dir("../../build").get()
rootProject.layout.buildDirectory.value(rootBuildDirectory)

subprojects {
    val subprojectBuildDirectory = rootBuildDirectory.dir(project.name)
    project.layout.buildDirectory.value(subprojectBuildDirectory)
}

subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
